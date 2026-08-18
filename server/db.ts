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
      if (!reportSnapshot.exists) return { status: "error" };
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
            const notExpired = expiresAt === null || !Number.isFinite(expiresAt) || Date.now() < expiresAt;
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
          const existingVoters = data.voters || [];
          if (existingVoters.length >= 50) {
            existingVoters.shift();
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
          const existingVoters = data.voters || [];
          if (existingVoters.length >= 50) {
            existingVoters.shift();
          }
          update.voters = [...existingVoters, voterId];
        }
        tx.update(docRef, update);
        return { status: "confirmed" as const, consensusCount: newConsensus, statusValue: newStatus };
      });
      return result;
    }
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to confirm report");
    return { status: "error" };
  }
}

export async function updateReportInFirestore(id: string, updateData: Record<string, any>) {
  const db = getDb();
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      await db.collection("reports").doc(id).update(updateData);
    } else {
      const { doc, updateDoc } = await loadClientSdk();
      await updateDoc(doc(db, "reports", id), updateData);
    }
    invalidateReportsCache();
    return true;
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to update report");
    return false;
  }
}

export async function deleteReportFromFirestore(id: string) {
  const db = getDb();
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      await db.collection("reports").doc(id).delete();
    } else {
      const { doc, deleteDoc } = await loadClientSdk();
      await deleteDoc(doc(db, "reports", id));
    }
    invalidateReportsCache();
    return true;
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to delete report");
    return false;
  }
}
