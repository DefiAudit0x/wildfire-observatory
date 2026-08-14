import { getDb, isAdminDb } from "./firebase.js";
import logger from "./logger.js";

async function loadClientSdk() {
  return import("firebase/firestore");
}

const COLLECTION_CACHE_TTL_MS = 30 * 1000;
const DOC_CACHE_TTL_MS = 60 * 1000;
const collectionCache = new Map<string, { data: any[] | null; expiresAt: number }>();
const docCache = new Map<string, { data: any | null; expiresAt: number }>();

export function invalidateCollectionCache(collectionName: string) {
  collectionCache.delete(collectionName);
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
  if (!db) return null;
  try {
    let data: any[] = [];
    if (isAdminDb(db)) {
      let ref: any = db.collection(collectionName);
      if (orderByField) ref = ref.orderBy(orderByField, "desc");
      if (limitCount) ref = ref.limit(limitCount);
      const snapshot = await ref.get();
      if (!snapshot.empty) {
        data = snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      }
    } else {
      const { collection, getDocs, query, orderBy, limit } = await loadClientSdk();
      let q: any = collection(db, collectionName);
      if (orderByField) q = query(q, orderBy(orderByField, "desc"));
      if (limitCount) q = query(q, limit(limitCount));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        data = snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      }
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
  if (!db) return null;
  try {
    let data: any | null = null;
    if (isAdminDb(db)) {
      const snap = await db.collection(collectionName).doc(id).get();
      data = snap.exists ? { id: snap.id, ...snap.data() } : null;
    } else {
      const { doc, getDoc } = await loadClientSdk();
      const snap = await getDoc(doc(db, collectionName, id));
      data = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }
    docCache.set(cacheKey, { data, expiresAt: Date.now() + DOC_CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc read failed");
    return null;
  }
}

export async function docSet(collectionName: string, id: string, data: any): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      await db.collection(collectionName).doc(id).set(data);
    } else {
      const { doc, setDoc } = await loadClientSdk();
      await setDoc(doc(db, collectionName, id), data);
    }
    invalidateCollectionCache(collectionName);
    invalidateDocCache(collectionName, id);
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc set failed");
    return false;
  }
}

export async function docUpdate(
  collectionName: string,
  id: string,
  data: Record<string, any>
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      await db.collection(collectionName).doc(id).update(data);
    } else {
      const { doc, updateDoc } = await loadClientSdk();
      await updateDoc(doc(db, collectionName, id), data);
    }
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
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      const { FieldValue } = await import("firebase-admin/firestore");
      await db.collection(collectionName).doc(id).update({ [field]: FieldValue.increment(amount) });
    } else {
      const { doc, updateDoc, increment } = await loadClientSdk();
      await updateDoc(doc(db, collectionName, id), { [field]: increment(amount) });
    }
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
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      await db.collection(collectionName).doc(id).delete();
    } else {
      const { doc, deleteDoc } = await loadClientSdk();
      await deleteDoc(doc(db, collectionName, id));
    }
    invalidateCollectionCache(collectionName);
    invalidateDocCache(collectionName, id);
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc delete failed");
    return false;
  }
}
