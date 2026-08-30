import { getDb, isAdminDb } from "./firebase.js";
import { citizenReports } from "./data.js";
import logger from "./logger.js";

async function loadClientSdk() {
  return import("firebase/firestore");
}

async function getAdminFirestoreModule() {
  return import("firebase-admin/firestore");
}

const REPORTS_CACHE_TTL_MS = 30 * 1000;
let reportsCache: { data: any[] | null; expiresAt: number } | null = null;

export function invalidateReportsCache() {
  reportsCache = null;
}

export type ReportsDbResult =
  | { status: "ok"; reports: any[] }
  | { status: "no-db" }
  | { status: "empty" }
  | { status: "error" };

/**
 * Returns a discriminated union so callers can distinguish:
 *  - "ok": reports were read from Firestore
 *  - "empty": Firestore reachable but the reports collection has no documents
 *  - "no-db": no Firestore is configured (or SKIP_FIREBASE)
 *  - "error": a read error occurred
 */
export async function getReportsDbResult(): Promise<ReportsDbResult> {
  if (reportsCache && Date.now() < reportsCache.expiresAt) {
    return reportsCache.data === null ? { status: "empty" } : { status: "ok", reports: reportsCache.data };
  }
  const db = getDb();
  if (!db) return { status: "no-db" };
  try {
    let data: any[] | null = null;
    if (isAdminDb(db)) {
      const snapshot = await db.collection("reports").orderBy("timestamp", "desc").limit(999).get();
      if (!snapshot.empty) {
        data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as any[];
      }
    } else {
      const { collection, getDocs, query, orderBy, limit } = await loadClientSdk();
      const reportsCol = collection(db, "reports");
      const q = query(reportsCol, orderBy("timestamp", "desc"), limit(999));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as any));
      }
    }
    if (data === null) return { status: "empty" };
    reportsCache = { data, expiresAt: Date.now() + REPORTS_CACHE_TTL_MS };
    return { status: "ok", reports: data };
  } catch (err) {
    logger.error({ err }, "Error reading reports from Firestore");
    return { status: "error" };
  }
}

export async function getReportsFromFirestore() {
  const result = await getReportsDbResult();
  return result.status === "ok" ? result.reports : null;
}

export async function seedReportsToFirestore(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      for (const rep of citizenReports) {
        await db.collection("reports").doc(rep.id).set(rep);
      }
    } else {
      const { setDoc, doc } = await loadClientSdk();
      for (const rep of citizenReports) {
        await setDoc(doc(db, "reports", rep.id), rep);
      }
    }
    // ARC-L03 fix: seeding writes the exact documents the reports cache holds —
    // serving a pre-seed cache afterwards hid the seeded rows for one TTL.
    invalidateReportsCache();
    logger.info("Seeded initial reports to Firestore");
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to seed reports");
    return false;
  }
}

export type ReportSaveResult = "saved" | "no-db" | "error";

export type IdempotentReportSaveResult =
  | { status: "saved"; report: any }
  | { status: "existing"; report: any }
  | { status: "same_id_different_body"; report: any }
  | { status: "integrity_failure" }
  | { status: "admin_required" }
  | { status: "no-db" }
  | { status: "error" };

export interface AtomicBadgeTrust {
  code: string;
  reporterType: "volunteer" | "official";
  wilaya: string;
  trustedReport: Record<string, unknown>;
}

const REPORT_IDEMPOTENCY_COLLECTION = "reportIdempotency";

/**
 * Produces a Firestore-safe persistence copy without changing the API/report
 * model used for canonical identity, responses, or in-memory behavior.
 * Undefined array members are rejected instead of silently changing order.
 */
function removeUndefinedDeepForFirestore<T>(value: T, path = "$"): T {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined) {
        throw new Error(`Firestore persistence contains undefined array item at ${path}[${index}]`);
      }
      return removeUndefinedDeepForFirestore(item, `${path}[${index}]`);
    }) as T;
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const normalized: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child !== undefined) {
          normalized[key] = removeUndefinedDeepForFirestore(child, `${path}.${key}`);
        }
      }
      return normalized as T;
    }
  }
  return value;
}

/**
 * Atomically creates a report and its durable origin-id record. The existing
 * report is returned for a retry; a fingerprint mismatch is classified for the
 * route as IDEMPOTENCY_KEY_REUSE. Legacy lookup is part of the Admin transaction
 * read-set and requires the canonicalizer supplied by the route.
 */
export type IdempotencyLookupResult =
  | { status: "found"; report: any; fingerprint: string }
  | { status: "missing" }
  | { status: "admin_required" }
  | { status: "no-db" }
  | { status: "error" };

export async function lookupReportIdempotency(clientGeneratedId: string): Promise<IdempotencyLookupResult> {
  const db = getDb();
  if (!db) return { status: "no-db" };
  try {
    if (isAdminDb(db)) {
      const keySnapshot = await db.collection(REPORT_IDEMPOTENCY_COLLECTION).doc(clientGeneratedId).get();
      if (!keySnapshot.exists) return { status: "missing" };
      const keyData = keySnapshot.data() as { reportId?: string; fingerprint?: string };
      if (!keyData.reportId || typeof keyData.fingerprint !== "string") return { status: "error" };
      const reportSnapshot = await db.collection("reports").doc(keyData.reportId).get();
      if (!reportSnapshot.exists) {
        // ARC-H3 fix: the admin deleted the report but its idempotency key
        // survived (nothing in the repo ever cleaned these up). The client's
        // offline draft then re-sent the SAME clientGeneratedId by design and
        // got a permanent 503 DURABLE_IDEMPOTENCY_UNAVAILABLE for that one
        // draft. An orphaned key is a repairable inconsistency, not a server
        // failure: drop the key and let the retry re-create the report.
        await db
          .collection(REPORT_IDEMPOTENCY_COLLECTION)
          .doc(clientGeneratedId)
          .delete()
          .catch(() => {});
        return { status: "missing" };
      }
      return {
        status: "found",
        report: { id: reportSnapshot.id, ...reportSnapshot.data() },
        fingerprint: keyData.fingerprint,
      };
    }

    return { status: "admin_required" };
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed idempotency lookup");
    return { status: "error" };
  }
}

export async function saveReportWithIdempotency(
  report: any,
  requestFingerprint: string,
  canonicalizeLegacyReport: (legacyReport: any) => string,
  badgeTrust?: AtomicBadgeTrust,
): Promise<IdempotentReportSaveResult> {
  const db = getDb();
  if (!db) return { status: "no-db" };

  try {
    if (isAdminDb(db)) {
      const idempotencyRef = db.collection(REPORT_IDEMPOTENCY_COLLECTION).doc(report.clientGeneratedId);
      const reportRef = db.collection("reports").doc(report.id);
      const result = await db.runTransaction(async (tx) => {
        const keySnapshot = await tx.get(idempotencyRef);
        if (keySnapshot.exists) {
          const keyData = keySnapshot.data() as { reportId?: string; fingerprint?: string };
          if (!keyData.reportId) throw new Error("Idempotency record is missing reportId");
          const existingSnapshot = await tx.get(db.collection("reports").doc(keyData.reportId));
          if (!existingSnapshot.exists) throw new Error("Idempotency record points to missing report");
          const existing = { id: existingSnapshot.id, ...existingSnapshot.data() };
          return {
            status: keyData.fingerprint === requestFingerprint ? "existing" as const : "same_id_different_body" as const,
            report: existing,
          };
        }

        const legacySnapshot = await tx.get(
          db.collection("reports")
            .where("clientGeneratedId", "==", report.clientGeneratedId)
            .limit(2),
        );
        if (legacySnapshot.size > 1) return { status: "integrity_failure" as const };
        if (legacySnapshot.size === 1) {
          const legacyDoc = legacySnapshot.docs[0];
          const legacyData = legacyDoc.data() as Record<string, unknown>;
          const legacy = { id: legacyDoc.id, ...legacyData };
          const storedLegacyFingerprint = legacyData.idempotencyFingerprint as string | undefined;
          const legacyFingerprint = typeof storedLegacyFingerprint === "string"
            ? storedLegacyFingerprint
            : canonicalizeLegacyReport?.(legacy);
          if (typeof legacyFingerprint === "string" && legacyFingerprint !== requestFingerprint) {
            return { status: "same_id_different_body" as const, report: legacy };
          }
          tx.create(idempotencyRef, {
            reportId: legacyDoc.id,
            clientGeneratedId: report.clientGeneratedId,
            fingerprint: requestFingerprint,
            createdAt: report.timestamp,
            backfilledAt: report.timestamp,
          });
          return { status: "existing" as const, report: legacy };
        }

        let reportToSave = report;
        if (badgeTrust) {
          const badgeRef = db.collection("badgeCodes").doc(badgeTrust.code);
          const badgeSnapshot = await tx.get(badgeRef);
          if (badgeSnapshot.exists) {
            const badge = badgeSnapshot.data() as Record<string, unknown>;
            const expiresAt = typeof badge.expiresAt === "number"
              ? badge.expiresAt
              : typeof badge.expiresAt === "string"
                ? new Date(badge.expiresAt).getTime()
                : null;
            // H3 fix: fail-closed — an unparseable/corrupt expiresAt (NaN,
            // Infinity) is treated as EXPIRED, never as never-expiring. A
            // badge with no expiry field (null) legitimately never expires.
            const notExpired = expiresAt === null || (Number.isFinite(expiresAt) && Date.now() < expiresAt);
            const maxUses = typeof badge.maxUses === "number" && badge.maxUses > 0 ? badge.maxUses : null;
            const usedCount = Number(badge.usedCount || 0);
            const underUsageCap = maxUses === null || usedCount < maxUses;
            const typeMatches = typeof badge.type !== "string" || badge.type === badgeTrust.reporterType;
            const wilayaMatches = typeof badge.wilaya !== "string" || !badge.wilaya || badge.wilaya === badgeTrust.wilaya;

            if (badge.isActive === true && typeMatches && notExpired && underUsageCap && wilayaMatches) {
              reportToSave = badgeTrust.trustedReport;
              tx.update(badgeRef, { usedCount: usedCount + 1 });
            }
          }
        }

        tx.create(reportRef, removeUndefinedDeepForFirestore(reportToSave));
        tx.create(idempotencyRef, {
          reportId: report.id,
          clientGeneratedId: report.clientGeneratedId,
          fingerprint: requestFingerprint,
          createdAt: report.timestamp,
        });
        return { status: "saved" as const, report: reportToSave };
      });
      invalidateReportsCache();
      return result;
    }

    return { status: "admin_required" };
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed atomic report/idempotency transaction");
    return { status: "error" };
  }
}

export async function saveReportToFirestore(report: any): Promise<ReportSaveResult> {
  const db = getDb();
  if (!db) return "no-db";
  try {
    if (isAdminDb(db)) {
      await db.collection("reports").doc(report.id).set(report);
    } else {
      const { setDoc, doc } = await loadClientSdk();
      await setDoc(doc(db, "reports", report.id), report);
    }
    invalidateReportsCache();
    return "saved";
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to save report");
    return "error";
  }
}

export type ConfirmReportResult =
  | { status: "confirmed"; consensusCount: number; statusValue: string }
  | { status: "already_voted" }
  | { status: "not_found" }
  | { status: "no_db" }
  | { status: "error" };

export async function confirmReportInFirestore(id: string, voterId?: string): Promise<ConfirmReportResult> {
  const db = getDb();
  if (!db) return { status: "no_db" };
  const CONSENSUS_THRESHOLD = 5;
  try {
    if (isAdminDb(db)) {
      const docRef = db.collection("reports").doc(id);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists) return { status: "not_found" as const };
        const data = snap.data() as any;
        if (voterId && data.voters?.includes(voterId)) {
          return { status: "already_voted" as const };
        }
        const newConsensus = (data.consensusCount || 0) + 1;
        let newStatus = data.status || "pending";
        if (newConsensus >= CONSENSUS_THRESHOLD && newStatus === "pending") {
          newStatus = "verified";
        }
        const update: Record<string, any> = { consensusCount: newConsensus, status: newStatus };
        if (voterId) {
          const existingVoters: string[] = data.voters || [];
          if (existingVoters.includes(voterId)) {
            return { status: "already_voted" as const };
          }
          if (existingVoters.length >= 50) {
            // H4 fix: never evict a recorded voter to admit a new one —
            // shift() re-opened already-counted identities, letting the
            // displayed consensusCount be inflated without bound (each new
            // wave of 50 pushed the count higher). The 5-vote verified
            // threshold is reached long before the cap, so overflow
            // confirmations are politely treated as already counted (same
            // 409 contract, no client change).
            return { status: "already_voted" as const };
          }
          update.voters = [...existingVoters, voterId];
        }
        tx.update(docRef, update);
        return { status: "confirmed" as const, consensusCount: newConsensus, statusValue: newStatus };
      });
      if (result.status === "confirmed") {
        invalidateReportsCache();
      }
      return result;
    } else {
      const { doc, runTransaction } = await loadClientSdk();
      const docRef = doc(db, "reports", id);
      const result = await runTransaction(db, async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists()) return { status: "not_found" as const };
        const data = snap.data() as any;
        if (voterId && data.voters?.includes(voterId)) {
          return { status: "already_voted" as const };
        }
        const newConsensus = (data.consensusCount || 0) + 1;
        let newStatus = data.status || "pending";
        if (newConsensus >= CONSENSUS_THRESHOLD && newStatus === "pending") {
          newStatus = "verified";
        }
        const update: Record<string, any> = { consensusCount: newConsensus, status: newStatus };
        if (voterId) {
          const existingVoters: string[] = data.voters || [];
          if (existingVoters.includes(voterId)) {
            return { status: "already_voted" as const };
          }
          if (existingVoters.length >= 50) {
            // H4 fix: never evict a recorded voter to admit a new one —
            // shift() re-opened already-counted identities, letting the
            // displayed consensusCount be inflated without bound (each new
            // wave of 50 pushed the count higher). The 5-vote verified
            // threshold is reached long before the cap, so overflow
            // confirmations are politely treated as already counted (same
            // 409 contract, no client change).
            return { status: "already_voted" as const };
          }
          update.voters = [...existingVoters, voterId];
        }
        tx.update(docRef, update);
        return { status: "confirmed" as const, consensusCount: newConsensus, statusValue: newStatus };
      });
      if (result.status === "confirmed") {
        invalidateReportsCache();
      }
      return result;
    }
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to confirm report");
    return { status: "error" };
  }
}

export type ReportMutationResult = "updated" | "deleted" | "no-db" | "missing" | "error";

/**
 * ARC-M05 fix: both mutations used to collapse missing / no-db / error into a
 * single `false`, so the admin route answered 404 for a live database outage
 * and happily mutated the in-memory seed while claiming success. The
 * discriminated result lets the route tell the operator the truth.
 */
export async function updateReportInFirestore(
  id: string,
  updateData: Record<string, any>
): Promise<ReportMutationResult> {
  const db = getDb();
  if (!db) return "no-db";
  try {
    if (isAdminDb(db)) {
      const docRef = db.collection("reports").doc(id);
      const snap = await docRef.get();
      if (!snap.exists) return "missing";
      await docRef.update(updateData);
    } else {
      const { doc, getDoc, updateDoc } = await loadClientSdk();
      const docRef = doc(db, "reports", id);
      const snap = await getDoc(docRef);
      if (!snap.exists()) return "missing";
      await updateDoc(docRef, updateData);
    }
    invalidateReportsCache();
    return "updated";
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to update report");
    return "error";
  }
}

export async function deleteReportFromFirestore(id: string): Promise<ReportMutationResult> {
  const db = getDb();
  if (!db) return "no-db";
  try {
    if (isAdminDb(db)) {
      const docRef = db.collection("reports").doc(id);
      const snap = await docRef.get();
      if (!snap.exists) return "missing";
      await docRef.delete();
    } else {
      const { doc, getDoc, deleteDoc } = await loadClientSdk();
      const docRef = doc(db, "reports", id);
      const snap = await getDoc(docRef);
      if (!snap.exists()) return "missing";
      await deleteDoc(docRef);
    }
    invalidateReportsCache();
    return "deleted";
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to delete report");
    return "error";
  }
}

export type ReportPurgeResult = "deleted" | "missing" | "no-db" | "error";

/**
 * ARC-H3 fix: deleting a report used to orphan its durable idempotency record
 * forever (nothing in the repo ever cleaned reportIdempotency). A client that
 * re-syncs its offline draft — same clientGeneratedId by design — then hit a
 * permanent 503 DURABLE_IDEMPOTENCY_UNAVAILABLE. This purge removes the report
 * and every idempotency key bound to it in one batch: the key stored on the
 * report itself (clientGeneratedId) plus any legacy key found by reportId.
 */
export async function purgeReportWithIdempotency(id: string): Promise<ReportPurgeResult> {
  const db = getDb();
  if (!db) return "no-db";
  try {
    if (isAdminDb(db)) {
      const reportRef = db.collection("reports").doc(id);
      const reportSnap = await reportRef.get();
      if (!reportSnap.exists) return "missing";
      const keys = new Set<string>();
      const cgid = (reportSnap.data() as any)?.clientGeneratedId;
      if (typeof cgid === "string" && cgid) keys.add(cgid);
      const legacy = await db
        .collection(REPORT_IDEMPOTENCY_COLLECTION)
        .where("reportId", "==", id)
        .get();
      legacy.forEach((d) => keys.add(d.id));
      const batch = db.batch();
      batch.delete(reportRef);
      for (const key of keys) {
        batch.delete(db.collection(REPORT_IDEMPOTENCY_COLLECTION).doc(key));
      }
      await batch.commit();
      invalidateReportsCache();
      return "deleted";
    }

    const { collection, doc, getDoc, getDocs, query, where, writeBatch } = await loadClientSdk();
    const reportRef = doc(db, "reports", id);
    const reportSnap = await getDoc(reportRef);
    if (!reportSnap.exists()) return "missing";
    const keys = new Set<string>();
    const cgid = reportSnap.data()?.clientGeneratedId;
    if (typeof cgid === "string" && cgid) keys.add(cgid);
    const legacy = await getDocs(
      query(collection(db, REPORT_IDEMPOTENCY_COLLECTION), where("reportId", "==", id))
    );
    legacy.forEach((d) => keys.add(d.id));
    const batch = writeBatch(db);
    batch.delete(reportRef);
    for (const key of keys) {
      batch.delete(doc(db, REPORT_IDEMPOTENCY_COLLECTION, key));
    }
    await batch.commit();
    invalidateReportsCache();
    return "deleted";
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to purge report with idempotency record");
    return "error";
  }
}
