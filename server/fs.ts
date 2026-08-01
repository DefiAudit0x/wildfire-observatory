import { getDb, isAdminDb } from "./firebase.js";
import logger from "./logger.js";

async function loadClientSdk() {
  return import("firebase/firestore");
}

export async function collectionGet(
  collectionName: string,
  orderByField?: string,
  limitCount?: number
): Promise<any[] | null> {
  const db = getDb();
  if (!db) return null;
  try {
    if (isAdminDb(db)) {
      let ref: any = db.collection(collectionName);
      if (orderByField) ref = ref.orderBy(orderByField, "desc");
      if (limitCount) ref = ref.limit(limitCount);
      const snapshot = await ref.get();
      if (snapshot.empty) return [];
      return snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    } else {
      const { collection, getDocs, query, orderBy, limit } = await loadClientSdk();
      let q: any = collection(db, collectionName);
      if (orderByField) q = query(q, orderBy(orderByField, "desc"));
      if (limitCount) q = query(q, limit(limitCount));
      const snapshot = await getDocs(q);
      if (snapshot.empty) return [];
      return snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    }
  } catch (err) {
    logger.error({ err, collectionName }, "Firestore collection read failed");
    return null;
  }
}

export async function docGet(collectionName: string, id: string): Promise<any | null> {
  const db = getDb();
  if (!db) return null;
  try {
    if (isAdminDb(db)) {
      const snap = await db.collection(collectionName).doc(id).get();
      return snap.exists ? { id: snap.id, ...snap.data() } : null;
    } else {
      const { doc, getDoc } = await loadClientSdk();
      const snap = await getDoc(doc(db, collectionName, id));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }
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
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc update failed");
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
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc delete failed");
    return false;
  }
}
