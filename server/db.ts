import { getDb, isAdminDb } from "./firebase.js";
import { runClustering } from "./geo.js";
import logger from "./logger.js";

async function loadClientSdk() {
  return import("firebase/firestore");
}

async function getAdminFirestoreModule() {
  return import("firebase-admin/firestore");
}

const REPORTS_CACHE_TTL_MS = 30 * 1000;
let reportsCache: { data: any[] | null; expiresAt: number } | null = null;
// S-H2 fix: the route answers from THIS cache — the clustered, sanitized wire
// list — so the O(n²) clustering runs at most once per TTL window, not once
// per request, and the wire shape (no PII, no inline base64) is computed once.
let reportsWireCache: { data: any[] | null; expiresAt: number } | null = null;

export function invalidateReportsCache() {
  reportsCache = null;
  reportsWireCache = null;
}

// ── S-H1 fix: citizen PII never lands in the publicly readable collection ────
// firestore.rules used to allow `read: if true` on /reports while the SAME doc
// carried reporterName/reporterPhone/reporterBadgeCode/deviceId — anyone with
// the embedded Firebase web config could harvest identities straight through
// the client SDK, bypassing the HTTP sanitization entirely. The fix is
// structural, not a filter: reports/{id} now holds ONLY public fields;
// identities go to reportPrivate/{id} (rules: read/write false — Admin SDK
// only) and the photo goes to reportImages/{id} (S-H2: the list payload no
// longer carries up-to-500KB base64 bodies; the image is fetched per-report
// via GET /api/reports/:id/image).
const REPORT_PRIVATE_COLLECTION = "reportPrivate";
const REPORT_IMAGES_COLLECTION = "reportImages";
const REPORT_PII_FIELDS = ["reporterName", "reporterPhone", "reporterBadgeCode", "deviceId"] as const;

/**
 * Splits a report into its three persistence shards. The public doc keeps
 * every operational field but carries `hasImage: true` instead of the base64
 * body; the private doc carries ONLY the identity fields; the image doc
 * carries ONLY the data URL.
 */
export function splitReportForPrivacy(report: any): {
  publicDoc: any;
  privateDoc: any | null;
  imageDataUrl: string | null;
} {
  const { reporterName, reporterPhone, reporterBadgeCode, deviceId, image, ...publicDoc } = report || {};
  const privateDoc: any = {};
  if (reporterName !== undefined) privateDoc.reporterName = reporterName;
  if (reporterPhone !== undefined) privateDoc.reporterPhone = reporterPhone;
  if (reporterBadgeCode !== undefined) privateDoc.reporterBadgeCode = reporterBadgeCode;
  if (deviceId !== undefined) privateDoc.deviceId = deviceId;
  const hasPrivate = Object.keys(privateDoc).length > 0;
  if (hasPrivate) privateDoc.reportId = report.id;
  const hasImage = typeof image === "string" && image.length > 0;
  if (hasImage) publicDoc.hasImage = true;
  return {
    publicDoc,
    privateDoc: hasPrivate ? privateDoc : null,
    imageDataUrl: hasImage ? image : null,
  };
}

/**
 * Public wire DTO (single canonical copy — routes re-export it). Everything
 * that could identify a reporter (phone, name, badge code, device id) AND the
 * inline base64 image stay server-side; the public map, websockets and POST
 * responses only ever see this shape.
 */
export function sanitizePublicReport(report: any): any {
  if (!report) return report;
  const {
    reporterPhone: _rp, reporterName: _rn, reporterBadgeCode: _rbc,
    deviceId: _did, image: _img, ...safe
  } = report;
  if (safe.hasImage === undefined && typeof report.image === "string" && report.image.length > 0) {
    safe.hasImage = true; // legacy inline rows keep their thumbnail contract
  }
  return safe;
}

/**
 * Strips PII/image from a doc READ from Firestore (defense in depth for
 * legacy rows written before the S-H1 split) and flags them for the
 * fire-and-forget migration below.
 */
function scrubLegacyReportFields(data: any): { doc: any; needsMigration: boolean } {
  const {
    reporterName: _rn, reporterPhone: _rp, reporterBadgeCode: _rbc,
    deviceId: _did, image: _img, ...safe
  } = data || {};
  const needsMigration = REPORT_PII_FIELDS.some((f) => data && data[f] !== undefined) ||
    typeof data?.image === "string";
  if (typeof data?.image === "string" && data.image.length > 0) {
    safe.hasImage = true;
  }
  return { doc: safe, needsMigration };
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
// ARC-L07: a bare limit(999) silently truncated the collection — report #1000
// vanished from every list, map and stat with no error and no pagination hint.
// Reads now page through the collection (admin cursor / client startAfter)
// up to a hard cap that bounds memory: 5000 docs ≈ the practical read budget
// for a 30s-cached list payload.
// S-H2 fix: with the base64 image (≤500KB/doc) and PII shards extracted at
// write time, a doc is now ~1-2KB of operational fields, so 5000 docs ≈ 10MB
// worst case — comfortably inside the 512MB fly machine instead of the
// previous ~2.5GB OOM vector.
const REPORTS_READ_CAP = 5000;
const READ_PAGE_SIZE = 999;

async function migrateLegacyReportRow(db: any, id: string, legacy: any): Promise<void> {
  try {
    const { publicDoc, privateDoc, imageDataUrl } = splitReportForPrivacy({ id, ...legacy });
    if (privateDoc) {
      await db.collection(REPORT_PRIVATE_COLLECTION).doc(id).set(privateDoc);
    }
    if (imageDataUrl) {
      await db.collection(REPORT_IMAGES_COLLECTION).doc(id).set({
        reportId: id,
        image: imageDataUrl,
        storedAt: new Date().toISOString(),
      });
    }
    await db.collection("reports").doc(id).set(publicDoc);
    logger.info({ reportId: id }, "Legacy report row migrated to privacy-split shards");
  } catch (err) {
    logger.warn({ err, reportId: id }, "Legacy report row migration failed (will retry next read)");
  }
}

export async function getReportsDbResult(): Promise<ReportsDbResult> {
  if (reportsCache && Date.now() < reportsCache.expiresAt) {
    return reportsCache.data === null ? { status: "empty" } : { status: "ok", reports: reportsCache.data };
  }
  const db = getDb();
  if (!db) return { status: "no-db" };
  try {
    let data: any[] | null = null;
    if (isAdminDb(db)) {
      let snapshot = await db.collection("reports").orderBy("timestamp", "desc").limit(READ_PAGE_SIZE).get();
      const docs: any[] = [...snapshot.docs];
      // Only chase another page when the current page came back FULL — a short
      // page proves the collection is exhausted and saves the extra round trip.
      while (snapshot.docs.length >= READ_PAGE_SIZE && docs.length < REPORTS_READ_CAP) {
        const last = docs[docs.length - 1];
        snapshot = await db.collection("reports").orderBy("timestamp", "desc").startAfter(last).limit(READ_PAGE_SIZE).get();
        if (snapshot.empty) break;
        docs.push(...snapshot.docs);
      }
      if (docs.length > 0) {
        const scrubbed = docs.slice(0, REPORTS_READ_CAP).map((d) => {
          const raw = d.data() as any;
          const { doc, needsMigration } = scrubLegacyReportFields(raw);
          if (needsMigration) {
            // Fire-and-forget: legacy rows carry PII/image inline; rewrite
            // them into the split shards so direct client-SDK reads of
            // reports/{id} stop exposing identities after this first read.
            void migrateLegacyReportRow(db, d.id, raw);
          }
          return { id: d.id, ...doc } as any;
        });
        data = scrubbed;
      }
    } else {
      const { collection, getDocs, query, orderBy, limit, startAfter } = await loadClientSdk();
      const reportsCol = collection(db, "reports");
      let snapshot = await getDocs(query(reportsCol, orderBy("timestamp", "desc"), limit(READ_PAGE_SIZE)));
      const docs: any[] = [...snapshot.docs];
      while (snapshot.docs.length >= READ_PAGE_SIZE && docs.length < REPORTS_READ_CAP) {
        const last = docs[docs.length - 1];
        snapshot = await getDocs(query(reportsCol, orderBy("timestamp", "desc"), startAfter(last), limit(READ_PAGE_SIZE)));
        if (snapshot.empty) break;
        docs.push(...snapshot.docs);
      }
      if (docs.length > 0) {
        data = docs.slice(0, REPORTS_READ_CAP).map((d) => {
          const { doc } = scrubLegacyReportFields(d.data() as any);
          return { id: d.id, ...doc } as any;
        });
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

/**
 * S-H2: the public wire list — validated, clustered (O(n²) once per TTL, not
 * per request) and sanitized. `/api/reports` serves THIS; every other
 * consumer (SOS proximity, wilaya stats, history, AI guidance) keeps reading
 * the raw operational list via getReportsDbResult.
 */
function isClusterableReport(value: any): value is import("../src/types.js").Report {
  return Boolean(value) &&
    typeof value.id === "string" && value.id.length > 0 &&
    Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90 &&
    Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180 &&
    typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp)) &&
    Number.isInteger(value.consensusCount) && value.consensusCount >= 0 &&
    ["low", "medium", "high", "critical"].includes(value.severity) &&
    ["pending", "verified", "rejected", "resolved"].includes(value.status);
}

export async function getPublicReportsWire(): Promise<ReportsDbResult> {
  if (reportsWireCache && Date.now() < reportsWireCache.expiresAt) {
    return reportsWireCache.data === null ? { status: "empty" } : { status: "ok", reports: reportsWireCache.data };
  }
  const result = await getReportsDbResult();
  if (result.status !== "ok") return result;
  if (!result.reports.every(isClusterableReport)) {
    logger.error("Report dataset failed runtime validation before clustering");
    return { status: "error" };
  }
  const wire = runClustering(result.reports).map(sanitizePublicReport);
  reportsWireCache = { data: wire, expiresAt: Date.now() + REPORTS_CACHE_TTL_MS };
  return { status: "ok", reports: wire };
}

/** Admin/status-notification flows read the identity shard by report id. */
export async function getReportPrivate(reportId: string): Promise<any | null> {
  const db = getDb();
  if (!db || !isAdminDb(db)) return null;
  try {
    const snap = await db.collection(REPORT_PRIVATE_COLLECTION).doc(reportId).get();
    return snap.exists ? snap.data() : null;
  } catch (err) {
    logger.warn({ err, reportId }, "reportPrivate read failed");
    return null;
  }
}

/**
 * The report image, served per-report by GET /api/reports/:id/image.
 * Reads the image shard first; falls back to the legacy inline field for
 * rows whose migration has not run yet.
 */
export async function getReportImageDataUrl(reportId: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  try {
    if (isAdminDb(db)) {
      const snap = await db.collection(REPORT_IMAGES_COLLECTION).doc(reportId).get();
      const fromShard = snap.exists ? (snap.data() as any)?.image : null;
      if (typeof fromShard === "string" && fromShard) return fromShard;
      const report = await db.collection("reports").doc(reportId).get();
      const legacy = report.exists ? (report.data() as any)?.image : null;
      return typeof legacy === "string" && legacy ? legacy : null;
    }
    return null;
  } catch (err) {
    logger.warn({ err, reportId }, "report image read failed");
    return null;
  }
}

// v2.3.0 (simulation purge): seedReportsToFirestore was removed. The server
// no longer fabricates demo reports into an empty database — an empty reports
// collection is now rendered as exactly that: no fires. Fire data comes from
// real citizen reports and live NASA FIRMS feeds only.

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

        // S-H1/S-H2: one transaction writes all shards — the public doc can
        // never be observed with PII or an inline base64 body, even briefly.
        const split = splitReportForPrivacy(reportToSave);
        tx.create(reportRef, removeUndefinedDeepForFirestore(split.publicDoc));
        if (split.privateDoc) {
          tx.create(db.collection(REPORT_PRIVATE_COLLECTION).doc(report.id),
            removeUndefinedDeepForFirestore(split.privateDoc));
        }
        if (split.imageDataUrl) {
          tx.create(db.collection(REPORT_IMAGES_COLLECTION).doc(report.id),
            removeUndefinedDeepForFirestore({
              reportId: report.id,
              image: split.imageDataUrl,
              storedAt: new Date().toISOString(),
            }));
        }
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
      // S-H1: the privacy-split shards must die with the report — leaving
      // reportPrivate (identity) or reportImages (photo) behind keeps PII
      // alive after the reporter (or an admin) believes the report is gone.
      await db.collection(REPORT_PRIVATE_COLLECTION).doc(id).delete().catch(() => {});
      await db.collection(REPORT_IMAGES_COLLECTION).doc(id).delete().catch(() => {});
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
      // S-H1: the split shards are part of the report's lifecycle — purge
      // them in the same batch (best-effort for rows written pre-split that
      // never had shards).
      batch.delete(db.collection(REPORT_PRIVATE_COLLECTION).doc(id));
      batch.delete(db.collection(REPORT_IMAGES_COLLECTION).doc(id));
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
