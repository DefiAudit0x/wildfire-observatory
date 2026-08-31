import { getDb, isAdminDb } from "./firebase.js";
import logger from "./logger.js";
import { stripUndefinedDeep } from "./clean.js";

async function loadClientSdk() {
  return import("firebase/firestore");
}

const COLLECTION_CACHE_TTL_MS = 30 * 1000;
const DOC_CACHE_TTL_MS = 60 * 1000;
const collectionCache = new Map<string, { data: any[] | null; expiresAt: number }>();
const docCache = new Map<string, { data: any | null; expiresAt: number }>();

/**
 * ARC-M03 fix: evict expired entries instead of leaving them until the exact
 * same key is re-read. Long-running processes read many distinct doc keys
 * (sosProfiles, badgeCodes, users, notifications…); without a sweep the maps
 * grow monotonically and the memory is never reclaimed even after expiry.
 */
function sweepExpired<T>(cache: Map<string, { expiresAt: number }>) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now >= entry.expiresAt) cache.delete(key);
  }
}

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
    sweepExpired(collectionCache);
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
    sweepExpired(docCache);
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
    const clean = stripUndefinedDeep(data);
    if (isAdminDb(db)) {
      await db.collection(collectionName).doc(id).set(clean);
    } else {
      const { doc, setDoc } = await loadClientSdk();
      await setDoc(doc(db, collectionName, id), clean);
    }
    invalidateCollectionCache(collectionName);
    invalidateDocCache(collectionName, id);
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc set failed");
    return false;
  }
}

/**
 * ARC-R1: merge variant of docSet. The team-position snapshot used to go
 * through docSet (full-document replacement), which destroyed every field it
 * did not carry — an in-flight snapshot racing a dispatcher's member removal
 * resurrected the removed member (active:false erased), and principal/joinedAt
 * were wiped 5 minutes into every shift. Merge-set touches ONLY the fields the
 * caller lists and never resurrects erased ones.
 */
export async function docMergeSet(collectionName: string, id: string, data: any): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    const clean = stripUndefinedDeep(data);
    if (isAdminDb(db)) {
      await db.collection(collectionName).doc(id).set(clean, { merge: true });
    } else {
      const { doc, setDoc } = await loadClientSdk();
      await setDoc(doc(db, collectionName, id), clean, { merge: true });
    }
    invalidateCollectionCache(collectionName);
    invalidateDocCache(collectionName, id);
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc merge-set failed");
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
  if (!db) return "unavailable";

  try {
    if (isAdminDb(db)) {
      const outcome = await db.runTransaction(async (tx: any) => {
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
      if (outcome === "created") {
        // ARC-H2 fix: the new SOS used to stay invisible to GET /api/sos and
        // to dispatch reads for up to COLLECTION_CACHE_TTL_MS because this was
        // the only fs.ts writer that never invalidated the collection cache.
        invalidateCollectionCache("trappedSos");
        invalidateDocCache("trappedSos", sosId);
      }
      return outcome;
    }

    const { doc, runTransaction } = await loadClientSdk();
    const outcome = await runTransaction(db, async (tx: any) => {
      const admissionRef = doc(db, "sosAdmissions", admissionId);
      const existing = await tx.get(admissionRef);
      const lastAcceptedAt = Number(existing.exists() ? existing.data()?.acceptedAt : 0);
      if (lastAcceptedAt > 0 && acceptedAt - lastAcceptedAt < windowMs) return "duplicate";

      tx.set(doc(db, "trappedSos", sosId), sosData);
      tx.set(admissionRef, {
        acceptedAt,
        expiresAt: acceptedAt + windowMs,
        sosId,
      });
      return "created";
    });
    if (outcome === "created") {
      invalidateCollectionCache("trappedSos");
      invalidateDocCache("trappedSos", sosId);
    }
    return outcome;
  } catch (err) {
    logger.error({ err, sosId }, "Firestore SOS admission transaction failed");
    return "unavailable";
  }
}

export type SosDispatchResult = "ok" | "missing" | "resolved" | "team_busy" | "unavailable";

/**
 * ARC-H2 + ARC-H8 fix: team dispatch used to be a read-modify-write outside
 * any transaction — two concurrent dispatches both read `dispatchedTeams: []`
 * and one silently overwrote the other. Worse, when the cached collection read
 * missed but a process-memory copy existed, the caller re-wrote the whole
 * document from its stale local copy, destroying fields written by another
 * instance (e.g. status=resolved).
 *
 * This helper performs the whole dispatch inside one transaction:
 *  - appends the dispatch item with a Firestore arrayUnion (no lost updates),
 *  - refuses to dispatch to a resolved SOS,
 *  - guards team uniqueness through a `teamMissions/{teamId}` document so one
 *    team cannot be on two active missions at once ("team_busy" for the loser).
 */
export async function appendSosDispatch(
  sosId: string,
  dispatchItem: Record<string, any>,
  missionTeamId: string
): Promise<SosDispatchResult> {
  const db = getDb();
  if (!db) return "unavailable";

  try {
    if (isAdminDb(db)) {
      const { FieldValue } = await import("firebase-admin/firestore");
      const outcome = await db.runTransaction(async (tx: any) => {
        const sosRef = db.collection("trappedSos").doc(sosId);
        const missionRef = db.collection("teamMissions").doc(missionTeamId);
        const [sosSnap, missionSnap] = await Promise.all([tx.get(sosRef), tx.get(missionRef)]);
        if (!sosSnap.exists) return "missing" as const;
        if (sosSnap.data()?.status === "resolved") return "resolved" as const;
        const missionData = missionSnap.exists ? missionSnap.data() || {} : null;
        if (missionData && missionData.phase !== "cleared") {
          if (missionData.sosId !== sosId) return "team_busy" as const;
          // ARC-R4: idempotent re-dispatch — this team is already locked on
          // THIS SOS. Re-appending would duplicate the dispatch log and
          // regress on_scene back to en_route (two 15s-stale operator tabs
          // double-clicking the same dispatch). Return ok with zero writes.
          return "ok" as const;
        }
        tx.update(sosRef, { dispatchedTeams: FieldValue.arrayUnion(dispatchItem) });
        tx.set(
          missionRef,
          { teamId: missionTeamId, sosId, phase: "en_route", since: Date.now() },
          { merge: true }
        );
        return "ok" as const;
      });
      invalidateCollectionCache("trappedSos");
      invalidateDocCache("trappedSos", sosId);
      invalidateCollectionCache("teamMissions");
      invalidateDocCache("teamMissions", missionTeamId);
      return outcome;
    }

    const { doc, runTransaction, arrayUnion } = await loadClientSdk();
    const outcome = await runTransaction(db, async (tx: any) => {
      const sosRef = doc(db, "trappedSos", sosId);
      const missionRef = doc(db, "teamMissions", missionTeamId);
      const [sosSnap, missionSnap] = await Promise.all([tx.get(sosRef), tx.get(missionRef)]);
      if (!sosSnap.exists()) return "missing" as const;
      if (sosSnap.data()?.status === "resolved") return "resolved" as const;
      const missionData = missionSnap.exists() ? missionSnap.data() || {} : null;
      if (missionData && missionData.phase !== "cleared") {
        if (missionData.sosId !== sosId) return "team_busy" as const;
        // ARC-R4: idempotent re-dispatch — see the admin branch above.
        return "ok" as const;
      }
      tx.update(sosRef, { dispatchedTeams: arrayUnion(dispatchItem) });
      tx.set(
        missionRef,
        { teamId: missionTeamId, sosId, phase: "en_route", since: Date.now() },
        { merge: true }
      );
      return "ok" as const;
    });
    invalidateCollectionCache("trappedSos");
    invalidateDocCache("trappedSos", sosId);
    invalidateCollectionCache("teamMissions");
    invalidateDocCache("teamMissions", missionTeamId);
    return outcome;
  } catch (err) {
    logger.error({ err, sosId, missionTeamId }, "Firestore SOS dispatch transaction failed");
    return "unavailable";
  }
}

/**
 * ARC-H8 companion: when an SOS is resolved, every team mission still pointing
 * at it is cleared so those teams become dispatchable again.
 */
export async function clearTeamMissionsForSos(sosId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    const missionIds: string[] = [];
    if (isAdminDb(db)) {
      const snap = await db.collection("teamMissions").where("sosId", "==", sosId).get();
      if (snap.empty) return true;
      const batch = db.batch();
      snap.forEach((docSnap: any) => {
        missionIds.push(docSnap.id);
        batch.update(docSnap.ref, { phase: "cleared", clearedAt: Date.now() });
      });
      await batch.commit();
    } else {
      const { collection, getDocs, query, where, writeBatch } = await loadClientSdk();
      const snap = await getDocs(query(collection(db, "teamMissions"), where("sosId", "==", sosId)));
      if (snap.empty) return true;
      const batch = writeBatch(db);
      snap.forEach((docSnap: any) => {
        missionIds.push(docSnap.id);
        batch.update(docSnap.ref, { phase: "cleared", clearedAt: Date.now() });
      });
      await batch.commit();
    }
    invalidateCollectionCache("teamMissions");
    for (const id of missionIds) invalidateDocCache("teamMissions", id);
    return true;
  } catch (err) {
    logger.error({ err, sosId }, "Firestore team mission clear failed");
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
    const clean = stripUndefinedDeep(data);
    if (isAdminDb(db)) {
      await db.collection(collectionName).doc(id).update(clean);
    } else {
      const { doc, updateDoc } = await loadClientSdk();
      await updateDoc(doc(db, collectionName, id), clean);
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
