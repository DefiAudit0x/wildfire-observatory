import { getDb, isAdminDb } from "./firebase.js";
import logger from "./logger.js";
import { stripUndefinedDeep } from "./clean.js";
import { saneCoord } from "./geo.js";
import type { Transaction as AdminTransaction } from "firebase-admin/firestore";
import type { Transaction as ClientTransaction } from "firebase/firestore";

async function loadClientSdk() {
  return import("firebase/firestore");
}

const COLLECTION_CACHE_TTL_MS = 30 * 1000;
const DOC_CACHE_TTL_MS = 60 * 1000;
const collectionCache = new Map<string, { data: any[] | null; expiresAt: number }>();
const docCache = new Map<string, { data: any | null; expiresAt: number }>();

/**
 * Fix 10b: per-collection generation guard against pending reads re-caching
 * invalidated data. A `collectionGet`/`docGet` awaits the Firestore read
 * after a cache miss; a writer committing in that window invalidates the old
 * entry, but the pending read then unconditionally re-set the pre-write
 * snapshot (up to 30s/60s TTL) — the invalidation was silently undone
 * (CodeRabbit on PR #139). Every invalidation bumps its collection's
 * generation, even when nothing is cached; a read caches only when the
 * generation is unchanged since it started. The key is the collection name
 * (bounded key space, no leak): a write to any doc in a collection bumps
 * that collection, which matches `invalidateCollectionCache` clearing every
 * cached query of the collection. The generation is NOT reset by pruning —
 * a stale generation value can only make a read skip caching, never serve
 * stale data.
 */
const cacheGenerations = new Map<string, number>();

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
  // Fix 10b: bump first, even with nothing cached — a read may be pending
  // in flight, and only the generation tells it its snapshot is stale.
  cacheGenerations.set(collectionName, (cacheGenerations.get(collectionName) ?? 0) + 1);
  for (const key of collectionCache.keys()) {
    if (key.startsWith(`${collectionName}::`)) collectionCache.delete(key);
  }
}

export function invalidateDocCache(collectionName: string, id: string) {
  // Fix 10b: a doc write bumps its collection's generation too, so a
  // pending collection read of the same collection cannot re-cache either.
  cacheGenerations.set(collectionName, (cacheGenerations.get(collectionName) ?? 0) + 1);
  const key = `${collectionName}/${id}`;
  docCache.delete(key);
}

function collectionCacheKey(collectionName: string, orderByField?: string, limitCount?: number) {
  return `${collectionName}::${orderByField || ""}::${limitCount || ""}`;
}

export async function collectionGet(
  collectionName: string,
  orderByField?: string,
  limitCount?: number,
  fresh = false
): Promise<any[] | null> {
  const cacheKey = collectionCacheKey(collectionName, orderByField, limitCount);
  const cached = collectionCache.get(cacheKey);
  if (!fresh && cached && Date.now() < cached.expiresAt) return cached.data;
  const db = getDb();
  if (!db) return null;
  // Fix 10b: capture the generation before the read — any invalidation
  // during the await must prevent this snapshot from being cached.
  const generation = cacheGenerations.get(collectionName) ?? 0;
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
    // Fix 10b: cache only if no write invalidated this collection while the
    // read was pending. The data is still returned to this caller — it is
    // merely not stored for the next one.
    if ((cacheGenerations.get(collectionName) ?? 0) === generation) {
      collectionCache.set(cacheKey, { data, expiresAt: Date.now() + COLLECTION_CACHE_TTL_MS });
    }
    return data;
  } catch (err) {
    logger.error({ err, collectionName }, "Firestore collection read failed");
    return null;
  }
}

/**
 * Team GPS snapshots are conditional on the membership still being active
 * and on the token generation that produced the fix. Reading and writing the
 * same member document in one transaction serializes the snapshot with leave
 * and dispatcher-removal transactions: a removal either follows this write
 * and purges it, or wins first and makes this snapshot skip.
 */
export async function docMergeTeamPositionIfActive(
  memberId: string,
  teamId: string,
  tokenGen: number,
  data: {
    memberId?: string;
    teamId?: string;
    name?: string;
    lastKnownLat?: number;
    lastKnownLng?: number;
    lastSeenAt?: number;
  }
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    const written = isAdminDb(db)
      ? await db.runTransaction(async (tx: AdminTransaction): Promise<boolean> => {
          const ref = db.collection("teamMembers").doc(memberId);
          const snap = await tx.get(ref);
          if (!snap.exists) return false;
          const member = snap.data() || {};
          if (member.active === false || member.teamId !== teamId || (Number(member.tokenGen) || 0) !== tokenGen) return false;
          tx.update(ref, stripUndefinedDeep(data));
          return true;
        })
      : await (async () => {
          const { doc, runTransaction } = await loadClientSdk();
          return runTransaction(db, async (tx: ClientTransaction): Promise<boolean> => {
            const ref = doc(db, "teamMembers", memberId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return false;
            const member = snap.data();
            if (member.active === false || member.teamId !== teamId || (Number(member.tokenGen) || 0) !== tokenGen) return false;
            tx.update(ref, stripUndefinedDeep(data));
            return true;
          });
        })();
    if (written) {
      invalidateCollectionCache("teamMembers");
      invalidateDocCache("teamMembers", memberId);
    }
    return written;
  } catch (err) {
    logger.warn({ err, memberId }, "Team position snapshot transaction failed");
    return false;
  }
}

// Security gates bypass cached account/revocation state across server processes.
// Fix 4c: opts.strict makes a failed read THROW instead of resolving null, so a
// caller that must tell "absent" from "unreadable" (the revocation gate) can
// fail closed. The default stays null-on-failure for all existing callers.
export async function docGet(collectionName: string, id: string, fresh = false, opts: { strict?: boolean } = {}): Promise<any | null> {
  const cacheKey = `${collectionName}/${id}`;
  const cached = docCache.get(cacheKey);
  if (!fresh && cached && Date.now() < cached.expiresAt) return cached.data;
  const db = getDb();
  if (!db) {
    if (opts.strict) throw new Error(`Firestore unavailable for ${collectionName}/${id}`);
    return null;
  }
  // Fix 10b: same generation guard as collectionGet — a writer committing
  // while this read is pending must prevent the stale snapshot from caching.
  const generation = cacheGenerations.get(collectionName) ?? 0;
  try {
    let data: any | null = null;
    if (isAdminDb(db)) {
      const snap = await db.collection(collectionName).doc(id).get();
      data = snap.exists ? { id: snap.id, ...snap.data() } : null;
    } else {
      const { doc, getDoc, getDocFromServer } = await loadClientSdk();
      const ref = doc(db, collectionName, id);
      const snap = await (fresh ? getDocFromServer(ref) : getDoc(ref));
      data = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }
    sweepExpired(docCache);
    // Fix 10b: cache only if no write invalidated this collection while the
    // read was pending; the data is still returned to this caller.
    if ((cacheGenerations.get(collectionName) ?? 0) === generation) {
      docCache.set(cacheKey, { data, expiresAt: Date.now() + DOC_CACHE_TTL_MS });
    }
    return data;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore doc read failed");
    if (opts.strict) throw err;
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
  windowMs: number,
  idempotency?: { collection: string; key: string; record: Record<string, any> }
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
        // v2.15.0 audit fix: the replay key commits in the SAME transaction
        // as the SOS. It used to be a separate non-atomic docSet AFTER
        // admission — a process crash or ledger-write failure between the
        // two left an admitted SOS with no replay key, so a client retry
        // (after the 5-min device window) created a true duplicate.
        if (idempotency) {
          tx.set(db.collection(idempotency.collection).doc(idempotency.key), idempotency.record);
        }
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
      // v2.15.0: same transaction on the client-SDK branch.
      if (idempotency) {
        tx.set(doc(db, idempotency.collection, idempotency.key), idempotency.record);
      }
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

export type SosDispatchResult = "ok" | "already_dispatched" | "missing" | "resolved" | "team_busy" | "unavailable";

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
        const sosData = sosSnap.data() || {};
        if (sosData.status === "resolved") return "resolved" as const;
        const missionData = missionSnap.exists ? missionSnap.data() || {} : null;
        if (missionData && missionData.phase !== "cleared") {
          if (missionData.sosId !== sosId) return "team_busy" as const;
          // ARC-R4: idempotent re-dispatch — this team is already locked on
          // THIS SOS. Re-appending would duplicate the dispatch log and
          // regress on_scene back to en_route (two 15s-stale operator tabs
          // double-clicking the same dispatch). Return "already_dispatched"
          // with zero writes (Fix 43 / SOS-6) so the caller can tell a
          // re-dispatch from a fresh one.
          return "already_dispatched" as const;
        }
        tx.update(sosRef, { dispatchedTeams: FieldValue.arrayUnion(dispatchItem) });
        // Phase 3: the mission doc carries its TARGET coordinates so the
        // mission/phase route can verify arrival geometry server-side. A
        // missing/garbled SOS coordinate degrades to null — verification is
        // then skipped (Phase-1 self-report contract) instead of poisoning
        // every haversine with NaN.
        tx.set(
          missionRef,
          {
            teamId: missionTeamId,
            sosId,
            phase: "en_route",
            since: Date.now(),
            sosLat: saneCoord(sosData.lat),
            sosLng: saneCoord(sosData.lng),
          },
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
      const sosData = sosSnap.data() || {};
      if (sosData.status === "resolved") return "resolved" as const;
      const missionData = missionSnap.exists() ? missionSnap.data() || {} : null;
      if (missionData && missionData.phase !== "cleared") {
        if (missionData.sosId !== sosId) return "team_busy" as const;
        // ARC-R4: idempotent re-dispatch — see the admin branch above.
        // Fix 43 (SOS-6): distinct outcome, zero writes.
        return "already_dispatched" as const;
      }
      tx.update(sosRef, { dispatchedTeams: arrayUnion(dispatchItem) });
      // Phase 3: target coordinates ride the mission doc — see admin branch.
      tx.set(
        missionRef,
        {
          teamId: missionTeamId,
          sosId,
          phase: "en_route",
          since: Date.now(),
          sosLat: saneCoord(sosData.lat),
          sosLng: saneCoord(sosData.lng),
        },
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

export type BadgeDeviceBindingResult = "bound" | "already_bound" | "conflict" | "unavailable";

/**
 * Pure badge-binding decision shared by both Firestore SDK branches: given a
 * badge document's data, decide the outcome without touching the
 * transaction. "bound" means the caller should write the binding.
 */
function decideBadgeBinding(
  current: Record<string, unknown>,
  deviceId: string
): BadgeDeviceBindingResult {
  if (current.isActive !== true) return "unavailable";
  if (current.expiresAt) {
    const expiry =
      typeof current.expiresAt === "number" ? current.expiresAt : Date.parse(String(current.expiresAt));
    if (Number.isFinite(expiry) && Date.now() >= expiry) return "unavailable";
  }
  const owner = typeof current.boundDeviceId === "string" ? current.boundDeviceId : "";
  if (owner) return owner === deviceId ? "already_bound" : "conflict";
  return "bound";
}

/**
 * Atomically binds a badge to its first verified device. Firestore retries a
 * transaction when another writer changes the badge after this transaction's
 * read, so concurrent first binders cannot both adopt the identity.
 */
export async function bindBadgeDeviceAtomic(
  badgeCode: string,
  deviceId: string,
  boundAt: string
): Promise<BadgeDeviceBindingResult> {
  const db = getDb();
  if (!db) return "unavailable";

  try {
    const outcome = isAdminDb(db)
      ? await db.runTransaction(async (tx: AdminTransaction): Promise<BadgeDeviceBindingResult> => {
          const ref = db.collection("badgeCodes").doc(badgeCode);
          const snap = await tx.get(ref);
          if (!snap.exists) return "unavailable";
          const decision = decideBadgeBinding(snap.data() || {}, deviceId);
          if (decision === "bound") tx.update(ref, { boundDeviceId: deviceId, boundAt });
          return decision;
        })
      : await (async () => {
          const { doc, runTransaction } = await loadClientSdk();
          return runTransaction(db, async (tx: ClientTransaction): Promise<BadgeDeviceBindingResult> => {
            const ref = doc(db, "badgeCodes", badgeCode);
            const snap = await tx.get(ref);
            if (!snap.exists()) return "unavailable";
            const decision = decideBadgeBinding(snap.data() || {}, deviceId);
            if (decision === "bound") tx.update(ref, { boundDeviceId: deviceId, boundAt });
            return decision;
          });
        })();

    if (outcome === "bound") {
      invalidateCollectionCache("badgeCodes");
      invalidateDocCache("badgeCodes", badgeCode);
    }
    return outcome;
  } catch (err) {
    logger.error({ err }, "Atomic badge device binding failed");
    return "unavailable";
  }
}

export type UserUpdateAuthorization = { status: number; error: string; code?: string } | null;

export type UserUpdateAtomicResult =
  | { outcome: "updated"; before: any; user: any }
  | { outcome: "not-found" }
  | { outcome: "forbidden"; status: number; error: string; code?: string }
  | { outcome: "unavailable" };

function unitDocumentId(unitId: string): string {
  const code = unitId.replace(/^unit-/i, "").toLowerCase();
  return `unit-${code}`;
}

/**
 * Fix 4d: atomically read, authorize and update a user document in one
 * Firestore transaction. The authorization callback runs against the
 * transaction's own read, so it re-runs on every transaction retry — a
 * promotion landing between the route's first read and the write is seen
 * by the guard and rejected, instead of slipping through a two-round-trip
 * read-then-write (the 4c fresh re-read narrowed that window but could
 * not close it: the read and the write were separate Firestore calls).
 * Mirrors bindBadgeDeviceAtomic (Fix 3). The caller keeps password
 * hashing outside the transaction.
 */
export async function updateUserAtomic(
  agentId: string,
  update: Record<string, any>,
  authorize: (target: any) => UserUpdateAuthorization
): Promise<UserUpdateAtomicResult> {
  const db = getDb();
  if (!db) return { outcome: "unavailable" };

  try {
    const clean = stripUndefinedDeep(update);
    const outcome = isAdminDb(db)
      ? await db.runTransaction(async (tx: AdminTransaction): Promise<UserUpdateAtomicResult> => {
          const ref = db.collection("users").doc(agentId);
          const snap = await tx.get(ref);
          if (!snap.exists) return { outcome: "not-found" };
          const before = snap.data() || {};
          const reason = authorize(before);
          if (reason) return { outcome: "forbidden", ...reason };
          const userUpdate = { ...clean };
          if (typeof clean.unitId === "string" && clean.unitId !== before.unitId) {
            const oldUnitId = before.unitId ? unitDocumentId(before.unitId) : null;
            const newUnitId = unitDocumentId(clean.unitId);
            if (oldUnitId !== newUnitId) {
              const oldUnitRef = oldUnitId ? db.collection("units").doc(oldUnitId) : null;
              const newUnitRef = db.collection("units").doc(newUnitId);
              const oldUnit = oldUnitRef ? await tx.get(oldUnitRef) : null;
              const newUnit = await tx.get(newUnitRef);
              const { FieldValue } = await import("firebase-admin/firestore");
              if (before.linkedStaffCounted === true && oldUnitRef && oldUnit?.exists) {
                tx.update(oldUnitRef, { linkedStaffCount: FieldValue.increment(-1) });
              }
              tx.update(newUnitRef, { linkedStaffCount: FieldValue.increment(1) });
              userUpdate.linkedStaffCounted = true;
            }
          }
          tx.update(ref, userUpdate);
          return { outcome: "updated", before, user: { ...before, ...userUpdate } };
        })
      : await (async () => {
          const { doc, runTransaction } = await loadClientSdk();
          return runTransaction(db, async (tx: ClientTransaction): Promise<UserUpdateAtomicResult> => {
            const ref = doc(db, "users", agentId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return { outcome: "not-found" };
            const before = snap.data() || {};
            const reason = authorize(before);
            if (reason) return { outcome: "forbidden", ...reason };
            const userUpdate = { ...clean };
            if (typeof clean.unitId === "string" && clean.unitId !== before.unitId) {
              const oldUnitId = before.unitId ? unitDocumentId(before.unitId) : null;
              const newUnitId = unitDocumentId(clean.unitId);
              if (oldUnitId !== newUnitId) {
                const oldUnitRef = oldUnitId ? doc(db, "units", oldUnitId) : null;
                const newUnitRef = doc(db, "units", newUnitId);
                const oldUnit = oldUnitRef ? await tx.get(oldUnitRef) : null;
                const newUnit = await tx.get(newUnitRef);
                const { increment } = await loadClientSdk();
                if (before.linkedStaffCounted === true && oldUnitRef && oldUnit?.exists()) {
                  tx.update(oldUnitRef, { linkedStaffCount: increment(-1) });
                }
                tx.update(newUnitRef, { linkedStaffCount: increment(1) });
                userUpdate.linkedStaffCounted = true;
              }
            }
            tx.update(ref, userUpdate);
            return { outcome: "updated", before, user: { ...before, ...userUpdate } };
          });
        })();

    if (outcome.outcome === "updated") {
      invalidateCollectionCache("users");
      invalidateDocCache("users", agentId);
      if (typeof clean.unitId === "string" && clean.unitId !== outcome.before.unitId) {
        const unitIds = new Set([outcome.before.unitId, clean.unitId].filter((unitId): unitId is string => typeof unitId === "string").map(unitDocumentId));
        for (const unitId of unitIds) invalidateDocCache("units", unitId);
        invalidateCollectionCache("units");
      }
    }
    return outcome;
  } catch (err) {
    logger.error({ err }, "Atomic user update failed");
    return { outcome: "unavailable" };
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

/**
 * B2 retention fix: delete specific fields from a document (FieldVale.delete /
 * deleteField sentinels). Member removal used to leave the last-known GPS
 * coordinates on the member doc forever — a removed device's location history
 * outliving its membership. The removal route now purges the position triple;
 * the doc shell (id, name, joinedAt, removedAt, active:false) stays for audit
 * and deterministic-rejoin idempotency.
 */
export async function docDeleteFields(
  collectionName: string,
  id: string,
  fields: string[]
): Promise<boolean> {
  if (fields.length === 0) return true;
  const db = getDb();
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      const { FieldValue } = await import("firebase-admin/firestore");
      const data: Record<string, any> = {};
      for (const f of fields) data[f] = FieldValue.delete();
      await db.collection(collectionName).doc(id).update(data);
    } else {
      const { doc, updateDoc, deleteField } = await loadClientSdk();
      const data: Record<string, any> = {};
      for (const f of fields) data[f] = deleteField();
      await updateDoc(doc(db, collectionName, id), data);
    }
    invalidateCollectionCache(collectionName);
    invalidateDocCache(collectionName, id);
    return true;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Firestore field delete failed");
    return false;
  }
}

export type TeamMemberRemovalResult =
  | { status: "removed"; tokenGen: number }
  | { status: "missing" }
  | { status: "unavailable" };

const MEMBER_GPS_FIELDS = ["lastKnownLat", "lastKnownLng", "lastSeenAt"];

/**
 * v2.15.0 audit fix — atomic member removal. The dispatcher's DELETE used to
 * be three sequential writes (incrementDocField tokenGen bump → docUpdate
 * active:false → docDeleteFields GPS purge) whose failures after the first
 * step were IGNORED while the route still answered ok:true — a removed member
 * could remain active:true with retained GPS residue and a misleading
 * success. Now the generation bump, the deactivation, and the GPS purge are
 ONE Firestore transaction on both SDK paths: a removed member can never be
 observed as active:true-with-bumped-gen, and ANY failure is surfaced as a
 503 instead of a fake success. (The security-critical order is preserved by
 construction: the token bump and the deactivation commit atomically.)
 */
export async function removeTeamMemberAtomically(memberId: string): Promise<TeamMemberRemovalResult> {
  const db = getDb();
  if (!db) return { status: "unavailable" };
  try {
    if (isAdminDb(db)) {
      const { FieldValue } = await import("firebase-admin/firestore");
      const outcome = await db.runTransaction(async (tx: any): Promise<TeamMemberRemovalResult> => {
        const ref = db.collection("teamMembers").doc(memberId);
        const snap = await tx.get(ref);
        if (!snap.exists) return { status: "missing" };
        const tokenGen = (Number(snap.data()?.tokenGen) || 0) + 1;
        const update: Record<string, any> = { tokenGen, active: false, removedAt: Date.now() };
        for (const f of MEMBER_GPS_FIELDS) update[f] = FieldValue.delete();
        tx.update(ref, update);
        return { status: "removed", tokenGen };
      });
      if (outcome.status === "removed") {
        invalidateCollectionCache("teamMembers");
        invalidateDocCache("teamMembers", memberId);
      }
      return outcome;
    }
    const { doc, runTransaction, deleteField } = await loadClientSdk();
    const outcome = await runTransaction(db, async (tx: any): Promise<TeamMemberRemovalResult> => {
      const ref = doc(db, "teamMembers", memberId);
      const snap = await tx.get(ref);
      if (!snap.exists()) return { status: "missing" };
      const tokenGen = (Number(snap.data()?.tokenGen) || 0) + 1;
      const update: Record<string, any> = { tokenGen, active: false, removedAt: Date.now() };
      for (const f of MEMBER_GPS_FIELDS) update[f] = deleteField();
      tx.update(ref, update);
      return { status: "removed", tokenGen };
    });
    if (outcome.status === "removed") {
      invalidateCollectionCache("teamMembers");
      invalidateDocCache("teamMembers", memberId);
    }
    return outcome;
  } catch (err) {
    logger.error({ err, memberId }, "Atomic team-member removal transaction failed");
    return { status: "unavailable" };
  }
}

export type SosResolveResult =
  | { status: "resolved"; missionsCleared: number }
  | { status: "missing" }
  | { status: "unavailable" };

/**
 * B4: resolve the SOS and clear its current missions in one transaction.
 * Dispatch writes the mission and appends its team ID to the same SOS document.
 * A dispatch that commits first is visible to resolve, including on retry.
 * A dispatch that loses the race reads the resolved status and is rejected.
 * Admin reads missions with an in-transaction ownership query. Client resolves
 * the dispatched team IDs to document references and checks current ownership
 * before writing. The returned count includes only the missions updated.
 */
export async function resolveSosAtomically(sosId: string): Promise<SosResolveResult> {
  const db = getDb();
  if (!db) return { status: "unavailable" };
  try {
    if (isAdminDb(db)) {
      // Fix 44 (FS-3): collect the cleared mission ids so their per-doc
      // cache entries can be invalidated after the commit — the collection
      // invalidation below never reached docGet readers, which kept
      // answering en_route/on_scene for up to 60 s after the resolve.
      const clearedMissionIds: string[] = [];
      const outcome = await db.runTransaction(async (tx: AdminTransaction): Promise<SosResolveResult> => {
        const sosRef = db.collection("trappedSos").doc(sosId);
        const sosSnap = await tx.get(sosRef);
        if (!sosSnap.exists) return { status: "missing" };
        const missionsSnap = await tx.get(db.collection("teamMissions").where("sosId", "==", sosId));
        tx.update(sosRef, { status: "resolved", resolvedAt: Date.now() });
        let missionsCleared = 0;
        missionsSnap.forEach((docSnap) => {
          tx.update(docSnap.ref, { phase: "cleared", clearedAt: Date.now() });
          clearedMissionIds.push(docSnap.id);
          missionsCleared += 1;
        });
        return { status: "resolved", missionsCleared };
      });
      if (outcome.status === "resolved") {
        invalidateCollectionCache("trappedSos");
        invalidateDocCache("trappedSos", sosId);
        invalidateCollectionCache("teamMissions");
        for (const id of clearedMissionIds) invalidateDocCache("teamMissions", id);
      }
      return outcome;
    }

    const { doc, runTransaction } = await loadClientSdk();
    // Fix 44 (FS-3): same per-doc invalidation as the Admin SDK branch above.
    const clearedMissionIds: string[] = [];
    const outcome = await runTransaction(db, async (tx: ClientTransaction): Promise<SosResolveResult> => {
      const sosRef = doc(db, "trappedSos", sosId);
      const sosSnap = await tx.get(sosRef);
      if (!sosSnap.exists()) return { status: "missing" };

      // Client Transaction.get accepts only document references.
      const dispatchedTeams: unknown = sosSnap.data().dispatchedTeams;
      const teamIds = new Set<string>();
      if (Array.isArray(dispatchedTeams)) {
        for (const dispatch of dispatchedTeams as ({ teamId?: unknown } | null)[]) {
          if (typeof dispatch?.teamId === "string" && dispatch.teamId) teamIds.add(dispatch.teamId);
        }
      }
      const missions = await Promise.all([...teamIds].map((teamId) => tx.get(doc(db, "teamMissions", teamId))));
      tx.update(sosRef, { status: "resolved", resolvedAt: Date.now() });
      let missionsCleared = 0;
      for (const mission of missions) {
        if (mission.data()?.sosId !== sosId) continue;
        tx.update(mission.ref, { phase: "cleared", clearedAt: Date.now() });
        clearedMissionIds.push(mission.ref.id);
        missionsCleared += 1;
      }
      return { status: "resolved", missionsCleared };
    });
    if (outcome.status === "resolved") {
      invalidateCollectionCache("trappedSos");
      invalidateDocCache("trappedSos", sosId);
      invalidateCollectionCache("teamMissions");
      for (const id of clearedMissionIds) invalidateDocCache("teamMissions", id);
    }
    return outcome;
  } catch (err) {
    logger.error({ err, sosId }, "Firestore SOS resolve transaction failed");
    return { status: "unavailable" };
  }
}
