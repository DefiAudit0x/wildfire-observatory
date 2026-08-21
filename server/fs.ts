import { getDb, isAdminDb } from "./firebase.js";
import logger from "./logger.js";

const COLLECTION_CACHE_TTL_MS = 30 * 1000;
const DOC_CACHE_TTL_MS = 60 * 1000;
const collectionCache = new Map<string, { data: any[] | null; expiresAt: number }>();
const docCache = new Map<string, { data: any | null; expiresAt: number }>();

export function invalidateCollectionCache(collectionName: string): void {
  const prefix = `${collectionName}::`;
  for (const key of collectionCache.keys()) {
    if (key.startsWith(prefix)) collectionCache.delete(key);
  }
}

export function invalidateDocCache(collectionName: string, id: string) {
  const key = `${collectionName}/${id}`;
  docCache.delete(key);
}

function collectionCacheKey(collectionName: string, orderByField?: string, limitCount?: number) {
  return `${collectionName}::${orderByField || ""}::${limitCount || ""}`;
}

export async function collectionGet(
  collectionName: string,
  orderByField?: string,
  limitCount?: number
): Promise<any[] | null> {
  const cacheKey = collectionCacheKey(collectionName, orderByField, limitCount);
  const cached = collectionCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const db = getDb();
  if (!db || !isAdminDb(db)) return null;
  try {
    let data: any[] = [];
    let ref: any = db.collection(collectionName);
    if (orderByField) ref = ref.orderBy(orderByField, "desc");
    if (limitCount) ref = ref.limit(limitCount);
    const snapshot = await ref.get();
    if (!snapshot.empty) {
      data = snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    }
    collectionCache.set(cacheKey, { data, expiresAt: Date.now() + COLLECTION_CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.error({ err, collectionName }, "Firestore collection read failed");
    return null;
  }
}

export async function docGet(collectionName: string, id: string): Promise<any | null> {
  const cacheKey = `${collectionName}/${id}`;
  const cached = docCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const db = getDb();
  if (!db || !isAdminDb(db)) return null;
  try {
    let data: any | null = null;
    const snap = await db.collection(collectionName).doc(id).get();
    data = snap.exists ? { id: snap.id, ...snap.data() } : null;
    docCache.set(cacheKey, { data, expiresAt: Date.now() + DOC_CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc read failed");
    return null;
  }
}

export async function docSet(collectionName: string, id: string, data: any): Promise<boolean> {
  const db = getDb();
  if (!db || !isAdminDb(db)) return false;
  try {
    await db.collection(collectionName).doc(id).set(data);
    invalidateCollectionCache(collectionName);
    invalidateDocCache(collectionName, id);
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc set failed");
    return false;
  }
}

export type SosAdmissionResult = "created" | "duplicate" | "unavailable";

/**
 * Atomically creates an SOS and records its per-device admission window.
 * The two documents share one Firestore transaction, preventing concurrent
 * requests from passing a process-local check-then-write gap.
 */
export async function createSosWithAdmission(
  sosId: string,
  sosData: Record<string, any>,
  admissionId: string,
  acceptedAt: number,
  windowMs: number
): Promise<SosAdmissionResult> {
  const db = getDb();
  if (!db || !isAdminDb(db)) return "unavailable";

  try {
    return await db.runTransaction(async (tx: any) => {
      const admissionRef = db.collection("sosAdmissions").doc(admissionId);
      const existing = await tx.get(admissionRef);
      const lastAcceptedAt = Number(existing.exists ? existing.data()?.acceptedAt : 0);
      if (lastAcceptedAt > 0 && acceptedAt - lastAcceptedAt < windowMs) return "duplicate";

      tx.set(db.collection("trappedSos").doc(sosId), sosData);
      tx.set(admissionRef, {
        acceptedAt,
        expiresAt: acceptedAt + windowMs,
        sosId,
      });
      return "created";
    });
  } catch (err) {
    logger.error({ err, sosId }, "Firestore SOS admission transaction failed");
    return "unavailable";
  }
}

export async function docUpdate(
  collectionName: string,
  id: string,
  data: Record<string, any>
): Promise<boolean> {
  const db = getDb();
  if (!db || !isAdminDb(db)) return false;
  try {
    await db.collection(collectionName).doc(id).update(data);
    invalidateCollectionCache(collectionName);
    invalidateDocCache(collectionName, id);
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc update failed");
    return false;
  }
}

/** Atomic counter bump — avoids the read-then-write race on hot docs. */
export async function incrementDocField(
  collectionName: string,
  id: string,
  field: string,
  amount = 1
): Promise<boolean> {
  const db = getDb();
  if (!db || !isAdminDb(db)) return false;
  try {
    const { FieldValue } = await import("firebase-admin/firestore");
    await db.collection(collectionName).doc(id).update({ [field]: FieldValue.increment(amount) });
    invalidateCollectionCache(collectionName);
    invalidateDocCache(collectionName, id);
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id, field }, "Firestore field increment failed");
    return false;
  }
}

export async function docDelete(collectionName: string, id: string): Promise<boolean> {
  const db = getDb();
  if (!db || !isAdminDb(db)) return false;
  try {
    await db.collection(collectionName).doc(id).delete();
    invalidateCollectionCache(collectionName);
    invalidateDocCache(collectionName, id);
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc delete failed");
    return false;
  }
}
