import { getDb, isAdminDb } from "./firebase.js";
import logger from "./logger.js";

export type AtomicCreateResult = "created" | "exists" | "unavailable";

export async function createDocIfAbsent(collectionName: string, id: string, data: Record<string, any>): Promise<AtomicCreateResult> {
  const db = getDb();
  if (!db) return "unavailable";
  try {
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any) => {
        const ref = db.collection(collectionName).doc(id);
        const existing = await tx.get(ref);
        if (existing.exists) return "exists";
        tx.create(ref, data);
        return "created";
      });
    }
    const { doc, runTransaction } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any) => {
      const ref = doc(db, collectionName, id);
      const existing = await tx.get(ref);
      if (existing.exists()) return "exists";
      tx.set(ref, data);
      return "created";
    });
  } catch (err) {
    logger.error({ err, collectionName, id }, "Atomic create failed");
    return "unavailable";
  }
}

export type UnitUserCreateResult = "created" | "exists" | "unit-missing" | "unavailable";

export async function createUserIfUnitExists(userId: string, unitId: string, data: Record<string, any>): Promise<UnitUserCreateResult> {
  const db = getDb();
  if (!db) return "unavailable";
  try {
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any) => {
        const unitRef = db.collection("units").doc(unitId);
        const userRef = db.collection("users").doc(userId);
        const unit = await tx.get(unitRef);
        if (!unit.exists) return "unit-missing";
        const existing = await tx.get(userRef);
        if (existing.exists) return "exists";
        tx.create(userRef, data);
        return "created";
      });
    }
    const { doc, runTransaction } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any) => {
      const unitRef = doc(db, "units", unitId);
      const userRef = doc(db, "users", userId);
      const unit = await tx.get(unitRef);
      if (!unit.exists()) return "unit-missing";
      const existing = await tx.get(userRef);
      if (existing.exists()) return "exists";
      tx.set(userRef, data);
      return "created";
    });
  } catch (err) {
    logger.error({ err, userId, unitId }, "Atomic user creation failed");
    return "unavailable";
  }
}

export type UnitDeleteResult = "deleted" | "missing" | "has-users" | "unavailable";

export async function deleteUnitIfUnlinked(unitId: string): Promise<UnitDeleteResult> {
  const db = getDb();
  if (!db) return "unavailable";
  try {
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any) => {
        const unitRef = db.collection("units").doc(unitId);
        const unit = await tx.get(unitRef);
        if (!unit.exists) return "missing";
        const users = await tx.get(db.collection("users").where("unitId", "==", unitId).limit(1));
        if (!users.empty) return "has-users";
        tx.delete(unitRef);
        return "deleted";
      });
    }
    const { collection, doc, limit, query, runTransaction, where } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any) => {
      const unitRef = doc(db, "units", unitId);
      const unit = await tx.get(unitRef);
      if (!unit.exists()) return "missing";
      const users = await tx.get(query(collection(db, "users"), where("unitId", "==", unitId), limit(1)));
      if (!users.empty) return "has-users";
      tx.delete(unitRef);
      return "deleted";
    });
  } catch (err) {
    logger.error({ err, unitId }, "Atomic unit deletion failed");
    return "unavailable";
  }
}

export async function getFreshDoc(collectionName: string, id: string): Promise<any | null> {
  const db = getDb();
  if (!db) return null;
  try {
    if (isAdminDb(db)) {
      const snap = await db.collection(collectionName).doc(id).get();
      return snap.exists ? { id: snap.id, ...snap.data() } : null;
    }
    const { doc, getDocFromServer } = await import("firebase/firestore");
    const snap = await getDocFromServer(doc(db, collectionName, id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (err) {
    logger.error({ err, collectionName, id }, "Fresh Firestore doc read failed");
    return null;
  }
}

export type RosterAppendResult = "created" | "limit" | "duplicate-agent" | "unavailable";

export async function appendRosterPostAtomic(collectionName: string, date: string, unitId: string, post: Record<string, any>, maxPosts: number): Promise<RosterAppendResult> {
  const db = getDb();
  if (!db) return "unavailable";
  try {
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any) => {
        const ref = db.collection(collectionName).doc(date);
        const snap = await tx.get(ref);
        const existing = snap.exists ? snap.data() : null;
        const posts: any[] = Array.isArray(existing?.posts) ? existing.posts : [];
        if (posts.length >= maxPosts) return "limit";
        const existingAgents = new Set(posts.flatMap((p: any) => Array.isArray(p.personnel) ? p.personnel.map((x: any) => x.agentId) : []));
        const incomingAgents = Array.isArray(post.personnel) ? post.personnel.map((x: any) => x.agentId) : [];
        if (incomingAgents.some((agentId: string) => existingAgents.has(agentId)) || new Set(incomingAgents).size !== incomingAgents.length) return "duplicate-agent";
        tx.set(ref, { unitId, date, posts: [...posts, post], updatedAt: new Date().toISOString() });
        return "created";
      });
    }
    const { doc, runTransaction } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any) => {
      const ref = doc(db, collectionName, date);
      const snap = await tx.get(ref);
      const existing = snap.exists() ? snap.data() : null;
      const posts: any[] = Array.isArray(existing?.posts) ? existing.posts : [];
      if (posts.length >= maxPosts) return "limit";
      const existingAgents = new Set(posts.flatMap((p: any) => Array.isArray(p.personnel) ? p.personnel.map((x: any) => x.agentId) : []));
      const incomingAgents = Array.isArray(post.personnel) ? post.personnel.map((x: any) => x.agentId) : [];
      if (incomingAgents.some((agentId: string) => existingAgents.has(agentId)) || new Set(incomingAgents).size !== incomingAgents.length) return "duplicate-agent";
      tx.set(ref, { unitId, date, posts: [...posts, post], updatedAt: new Date().toISOString() });
      return "created";
    });
  } catch (err) {
    logger.error({ err, collectionName, date }, "Atomic roster append failed");
    return "unavailable";
  }
}

const VOLUNTEER_NAME_RESERVATION_MS = 30 * 24 * 60 * 60 * 1000;

type VolunteerReservationData = {
  registrationId?: string;
  kind?: "phone" | "email" | "name";
  createdAt?: string;
  expiresAt?: number;
};

export type VolunteerRegistrationResult = "created" | "duplicate-phone" | "duplicate-email" | "duplicate-name" | "unavailable";

export async function createVolunteerRegistrationAtomically(
  registration: Record<string, any>,
  keys: { phoneHash: string; emailHash?: string; fullNameHash: string },
): Promise<VolunteerRegistrationResult> {
  const db = getDb();
  if (!db) return "unavailable";
  const reservationCollection = "volunteerRegistrationUniqueness";
  const reservationIds = [
    { kind: "phone" as const, key: keys.phoneHash },
    ...(keys.emailHash ? [{ kind: "email" as const, key: keys.emailHash }] : []),
    { kind: "name" as const, key: `${keys.fullNameHash}:${registration.wilaya}` },
  ];
  const createdAtMs = Date.parse(typeof registration.createdAt === "string" ? registration.createdAt : "");
  const nameExpiresAt = Number.isFinite(createdAtMs) ? createdAtMs + VOLUNTEER_NAME_RESERVATION_MS : Date.now() + VOLUNTEER_NAME_RESERVATION_MS;

  try {
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any) => {
        const refs = reservationIds.map(({ kind, key }) => ({ kind, ref: db.collection(reservationCollection).doc(`${kind}-${key}`) }));
        const snapshots = await Promise.all(refs.map(({ ref }) => tx.get(ref)));
        for (let i = 0; i < snapshots.length; i++) {
          if (!snapshots[i].exists) continue;
          const data = snapshots[i].data() as VolunteerReservationData;
          if (!data.registrationId) return "unavailable";
          const existing = await tx.get(db.collection("volunteerRegistrations").doc(data.registrationId));
          const existingData = existing.exists ? existing.data() : null;
          const rejected = existing.exists && existingData?.status === "rejected";
          const nameExpired = refs[i].kind === "name" && typeof data.expiresAt === "number" && data.expiresAt <= Date.now();
          if (existing.exists && !rejected && !nameExpired) {
            return refs[i].kind === "phone" ? "duplicate-phone" : refs[i].kind === "email" ? "duplicate-email" : "duplicate-name";
          }
        }
        for (const { kind, ref } of refs) {
          tx.set(ref, {
            registrationId: registration.id,
            kind,
            createdAt: registration.createdAt,
            ...(kind === "name" ? { expiresAt: nameExpiresAt } : {}),
          });
        }
        tx.create(db.collection("volunteerRegistrations").doc(registration.id), registration);
        return "created";
      });
    }
    const { doc, runTransaction } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any) => {
      const refs = reservationIds.map(({ kind, key }) => ({ kind, ref: doc(db, reservationCollection, `${kind}-${key}`) }));
      const snapshots = await Promise.all(refs.map(({ ref }) => tx.get(ref)));
      for (let i = 0; i < snapshots.length; i++) {
        if (!snapshots[i].exists()) continue;
        const data = snapshots[i].data() as VolunteerReservationData;
        if (!data.registrationId) return "unavailable";
        const existing = await tx.get(doc(db, "volunteerRegistrations", data.registrationId));
        const existingData = existing.exists() ? existing.data() : null;
        const rejected = existing.exists() && existingData?.status === "rejected";
        const nameExpired = refs[i].kind === "name" && typeof data.expiresAt === "number" && data.expiresAt <= Date.now();
        if (existing.exists() && !rejected && !nameExpired) {
          return refs[i].kind === "phone" ? "duplicate-phone" : refs[i].kind === "email" ? "duplicate-email" : "duplicate-name";
        }
      }
      for (const { kind, ref } of refs) {
        tx.set(ref, {
          registrationId: registration.id,
          kind,
          createdAt: registration.createdAt,
          ...(kind === "name" ? { expiresAt: nameExpiresAt } : {}),
        });
      }
      tx.set(doc(db, "volunteerRegistrations", registration.id), registration);
      return "created";
    });
  } catch (err) {
    logger.error({ err, registrationId: registration.id }, "Atomic volunteer registration failed");
    return "unavailable";
  }
}

export type VolunteerApprovalResult = "updated" | "missing" | "badge-exists" | "unavailable";

export async function approveVolunteerAtomically(registrationId: string, registrationUpdate: Record<string, any>, badgeCode: string, badgeData: Record<string, any>): Promise<VolunteerApprovalResult> {
  const db = getDb();
  if (!db) return "unavailable";
  try {
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any) => {
        const registrationRef = db.collection("volunteerRegistrations").doc(registrationId);
        const registration = await tx.get(registrationRef);
        if (!registration.exists) return "missing";
        const badgeRef = db.collection("badgeCodes").doc(badgeCode);
        const badge = await tx.get(badgeRef);
        if (badge.exists) return "badge-exists";
        tx.update(registrationRef, registrationUpdate);
        tx.create(badgeRef, badgeData);
        return "updated";
      });
    }
    const { doc, runTransaction } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any) => {
      const registrationRef = doc(db, "volunteerRegistrations", registrationId);
      const registration = await tx.get(registrationRef);
      if (!registration.exists()) return "missing";
      const badgeRef = doc(db, "badgeCodes", badgeCode);
      const badge = await tx.get(badgeRef);
      if (badge.exists()) return "badge-exists";
      tx.update(registrationRef, registrationUpdate);
      tx.set(badgeRef, badgeData);
      return "updated";
    });
  } catch (err) {
    logger.error({ err, registrationId, badgeCode }, "Atomic volunteer approval failed");
    return "unavailable";
  }
}
