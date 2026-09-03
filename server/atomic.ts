import { getDb, isAdminDb } from "./firebase.js";
import logger from "./logger.js";
import { stripUndefinedDeep } from "./clean.js";

export type AtomicCreateResult = "created" | "exists" | "unavailable";

export async function createDocIfAbsent(collectionName: string, id: string, data: Record<string, any>): Promise<AtomicCreateResult> {
  const db = getDb();
  if (!db) return "unavailable";
  try {
    const clean = stripUndefinedDeep(data);
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any) => {
        const ref = db.collection(collectionName).doc(id);
        const existing = await tx.get(ref);
        if (existing.exists) return "exists";
        tx.create(ref, clean);
        return "created";
      });
    }
    const { doc, runTransaction } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any) => {
      const ref = doc(db, collectionName, id);
      const existing = await tx.get(ref);
      if (existing.exists()) return "exists";
      tx.set(ref, clean);
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
        tx.create(userRef, stripUndefinedDeep(data));
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
      tx.set(userRef, stripUndefinedDeep(data));
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

export type FreshDocResult =
  | { status: "found"; doc: any }
  | { status: "missing" }
  | { status: "error" };

/**
 * ARC-L04 fix: `getFreshDoc` collapses three different outcomes (missing doc,
 * database unavailable, read error) into a single `null`, so callers like the
 * roster validator report "agent is not an active staff account" when the
 * real problem is a database outage. Callers that need to distinguish these
 * cases should prefer this discriminated-union variant.
 */
export async function getFreshDocResult(collectionName: string, id: string): Promise<FreshDocResult> {
  const db = getDb();
  if (!db) return { status: "error" };
  try {
    if (isAdminDb(db)) {
      const snap = await db.collection(collectionName).doc(id).get();
      return snap.exists ? { status: "found", doc: { id: snap.id, ...snap.data() } } : { status: "missing" };
    }
    const { doc, getDocFromServer } = await import("firebase/firestore");
    const snap = await getDocFromServer(doc(db, collectionName, id));
    return snap.exists() ? { status: "found", doc: { id: snap.id, ...snap.data() } } : { status: "missing" };
  } catch (err) {
    logger.error({ err, collectionName, id }, "Fresh Firestore doc read failed");
    return { status: "error" };
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
        tx.set(ref, stripUndefinedDeep({ unitId, date, posts: [...posts, post], updatedAt: new Date().toISOString() }));
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
      tx.set(ref, stripUndefinedDeep({ unitId, date, posts: [...posts, post], updatedAt: new Date().toISOString() }));
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
          tx.set(ref, stripUndefinedDeep({
            registrationId: registration.id,
            kind,
            createdAt: registration.createdAt,
            ...(kind === "name" ? { expiresAt: nameExpiresAt } : {}),
          }));
        }
        tx.create(db.collection("volunteerRegistrations").doc(registration.id), stripUndefinedDeep(registration));
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
        tx.set(ref, stripUndefinedDeep({
          registrationId: registration.id,
          kind,
          createdAt: registration.createdAt,
          ...(kind === "name" ? { expiresAt: nameExpiresAt } : {}),
        }));
      }
      tx.set(doc(db, "volunteerRegistrations", registration.id), stripUndefinedDeep(registration));
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
        tx.update(registrationRef, stripUndefinedDeep(registrationUpdate));
        tx.create(badgeRef, stripUndefinedDeep(badgeData));
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
      tx.update(registrationRef, stripUndefinedDeep(registrationUpdate));
      tx.set(badgeRef, stripUndefinedDeep(badgeData));
      return "updated";
    });
  } catch (err) {
    logger.error({ err, registrationId, badgeCode }, "Atomic volunteer approval failed");
    return "unavailable";
  }
}

export type TeamJoinResult =
  | { status: "joined"; member: Record<string, any>; tokenGen: number }
  | { status: "code-invalid" }
  | { status: "code-expired" }
  | { status: "code-exhausted" }
  | { status: "team-inactive" }
  | { status: "principal-blocked" }
  | { status: "unavailable" };

/**
 * Team Mode (Phase 1): a join-code redemption that must be atomic because the
 * code carries a use budget. The pre-check in the route only filters obvious
 * misses; two devices submitting the last remaining use of a code MUST NOT
 * both pass. Inside one transaction the code doc is re-read fresh and
 * re-validated (revocation, expiry, use budget), the budget is incremented,
 * and the member record is upserted — so re-joining the same team from the
 * same principal reactivates the same member instead of duplicating it.
 *
 * B1 revocation: the redemption re-reads the member's `tokenGen` inside the
 * transaction and returns it so the route mints a token with the CURRENT
 * generation. B2 blocking: a principal the dispatcher explicitly blocked
 * (lost device) is rejected here INSIDE the transaction — no route-level
 * race can slip a blocked device back onto the map.
 */
export async function joinTeamAtomically(
  code: string,
  memberId: string,
  memberData: Record<string, any>
): Promise<TeamJoinResult> {
  const db = getDb();
  if (!db) return { status: "unavailable" };
  try {
    if (isAdminDb(db)) {
      const { FieldValue } = await import("firebase-admin/firestore");
      return await db.runTransaction(async (tx: any): Promise<TeamJoinResult> => {
        const codeRef = db.collection("teamJoinCodes").doc(code);
        const codeSnap = await tx.get(codeRef);
        if (!codeSnap.exists) return { status: "code-invalid" };
        const codeDoc = codeSnap.data() || {};
        const now = Date.now();
        if (codeDoc.revoked === true) return { status: "code-invalid" };
        const expiresAt = typeof codeDoc.expiresAt === "number" ? codeDoc.expiresAt : Date.parse(codeDoc.expiresAt);
        if (Number.isFinite(expiresAt) && now >= expiresAt) return { status: "code-expired" };

        // Rejoin-budget (Phase C): the member doc must be read BEFORE the
        // budget gate. An ACTIVE member's refresh rejoin is not a use — the
        // old order burned one of the code's maxUses on every refresh (6
        // vehicles × 2 refreshes/day exhausted a 12-use code within a shift).
        // Only a FIRST join or a re-admission after a removal (doc absent or
        // active:false) consumes the budget.
        const memberRef = db.collection("teamMembers").doc(memberId);
        const memberSnap = await tx.get(memberRef);
        const activeRefresh = memberSnap.exists && memberSnap.data()?.active !== false;

        const uses = Number(codeDoc.uses) || 0;
        const maxUses = Number(codeDoc.maxUses) || 0;
        if (!activeRefresh && maxUses > 0 && uses >= maxUses) return { status: "code-exhausted" };

        const teamRef = db.collection("teams").doc(codeDoc.teamId);
        const teamSnap = await tx.get(teamRef);
        if (!teamSnap.exists) return { status: "code-invalid" };
        if (teamSnap.data()?.active === false) return { status: "team-inactive" };
        const blocked = teamSnap.data()?.blockedPrincipals;
        if (Array.isArray(blocked) && memberData.principal && blocked.includes(memberData.principal)) {
          return { status: "principal-blocked" };
        }

        const tokenGen = Number(memberSnap.data()?.tokenGen) || 0;
        const member = {
          ...memberData,
          // First join stamps joinedAt; a rejoin keeps the original (undefined
          // is stripped before the write, and merge:true preserves the field).
          joinedAt: memberSnap.exists ? undefined : now,
          rejoinCount: (Number(memberSnap.data()?.rejoinCount) || 0) + 1,
          lastSeenAt: now,
          active: true,
          // tokenGen is PRESERVED on rejoin: a bump applied while the member
          // was removed must survive the reactivation, or the removal's
          // revocation would be undone by the very act of rejoining.
          tokenGen: undefined,
        };
        tx.set(memberRef, stripUndefinedDeep(member), { merge: true });
        // Rejoin-budget: an active refresh refreshes the timestamp only; a
        // genuine first join or re-admission consumes one use.
        tx.update(codeRef, activeRefresh
          ? { lastUsedAt: now }
          : { uses: FieldValue.increment(1), lastUsedAt: now });
        return { status: "joined", member, tokenGen };
      });
    }

    const { doc, runTransaction, increment } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any): Promise<TeamJoinResult> => {
      const codeRef = doc(db, "teamJoinCodes", code);
      const codeSnap = await tx.get(codeRef);
      if (!codeSnap.exists()) return { status: "code-invalid" };
      const codeDoc = codeSnap.data() || {};
      const now = Date.now();
      if (codeDoc.revoked === true) return { status: "code-invalid" };
      const expiresAt = typeof codeDoc.expiresAt === "number" ? codeDoc.expiresAt : Date.parse(codeDoc.expiresAt);
      if (Number.isFinite(expiresAt) && now >= expiresAt) return { status: "code-expired" };

      // Rejoin-budget (Phase C): mirror of the admin-SDK branch above.
      const memberRef = doc(db, "teamMembers", memberId);
      const memberSnap = await tx.get(memberRef);
      const activeRefresh = memberSnap.exists() && memberSnap.data()?.active !== false;

      const uses = Number(codeDoc.uses) || 0;
      const maxUses = Number(codeDoc.maxUses) || 0;
      if (!activeRefresh && maxUses > 0 && uses >= maxUses) return { status: "code-exhausted" };

      const teamRef = doc(db, "teams", codeDoc.teamId);
      const teamSnap = await tx.get(teamRef);
      if (!teamSnap.exists()) return { status: "code-invalid" };
      if (teamSnap.data()?.active === false) return { status: "team-inactive" };
      const blocked = teamSnap.data()?.blockedPrincipals;
      if (Array.isArray(blocked) && memberData.principal && blocked.includes(memberData.principal)) {
        return { status: "principal-blocked" };
      }

      const tokenGen = Number(memberSnap.data()?.tokenGen) || 0;
      const member = {
        ...memberData,
        joinedAt: memberSnap.exists() ? undefined : now,
        rejoinCount: (Number(memberSnap.data()?.rejoinCount) || 0) + 1,
        lastSeenAt: now,
        active: true,
        tokenGen: undefined,
      };
      tx.set(memberRef, stripUndefinedDeep(member), { merge: true });
      // Rejoin-budget: mirror of the admin-SDK branch above.
      tx.update(codeRef, activeRefresh
        ? { lastUsedAt: now }
        : { uses: increment(1), lastUsedAt: now });
      return { status: "joined", member, tokenGen };
    });
  } catch (err) {
    logger.error({ err, code: "[join-code]", memberId }, "Atomic team join failed");
    return { status: "unavailable" };
  }
}

export type MissionPhaseResult =
  | { status: "updated"; mission: Record<string, any> }
  | { status: "no-active-mission" }
  | { status: "unavailable" };

/**
 * Team Mode (Phase 1): a field team marks its own phase progression on the
 * active mission (en_route → on_scene). Cleared stays admin-only (SOS resolve
 * frees teams via clearTeamMissionsForSos). Transactional read-then-write so
 * a team racing an admin resolve cannot resurrect a cleared mission.
 */
export async function setMissionPhaseAtomically(
  teamId: string,
  phase: "on_scene",
  now = Date.now()
): Promise<MissionPhaseResult> {
  const db = getDb();
  if (!db) return { status: "unavailable" };
  try {
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any): Promise<MissionPhaseResult> => {
        const missionRef = db.collection("teamMissions").doc(teamId);
        const missionSnap = await tx.get(missionRef);
        if (!missionSnap.exists || missionSnap.data()?.phase === "cleared" || !missionSnap.data()?.sosId) {
          return { status: "no-active-mission" };
        }
        const mission = { ...missionSnap.data(), phase, since: missionSnap.data()?.since, phaseUpdatedAt: now };
        tx.update(missionRef, { phase, phaseUpdatedAt: now });
        return { status: "updated", mission };
      });
    }
    const { doc, runTransaction } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any): Promise<MissionPhaseResult> => {
      const missionRef = doc(db, "teamMissions", teamId);
      const missionSnap = await tx.get(missionRef);
      if (!missionSnap.exists() || missionSnap.data()?.phase === "cleared" || !missionSnap.data()?.sosId) {
        return { status: "no-active-mission" };
      }
      const mission = { ...missionSnap.data(), phase, phaseUpdatedAt: now };
      tx.update(missionRef, { phase, phaseUpdatedAt: now });
      return { status: "updated", mission };
    });
  } catch (err) {
    logger.error({ err, teamId, phase }, "Atomic mission phase update failed");
    return { status: "unavailable" };
  }
}

export type MissionClearResult =
  | { status: "cleared"; mission: Record<string, any> }
  | { status: "no-active-mission" }
  | { status: "unavailable" };

/**
 * B3 admin lever: force-clear a stuck team mission. Until now the ONLY thing
 * that freed a dispatched team was resolving its SOS — a mission whose SOS
 * record was deleted, or that raced a resolve, wedged the team as
 * "busy forever" with no operator escape. This is the same write SOS-resolve
 * performs, exposed as a deliberate dispatcher action inside a transaction so
 * a team racing a phase flip cannot resurrect the mission (same guard as
 * setMissionPhaseAtomically: cleared stays cleared).
 */
export async function clearTeamMissionAtomically(
  teamId: string,
  now = Date.now()
): Promise<MissionClearResult> {
  const db = getDb();
  if (!db) return { status: "unavailable" };
  try {
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any): Promise<MissionClearResult> => {
        const missionRef = db.collection("teamMissions").doc(teamId);
        const missionSnap = await tx.get(missionRef);
        if (!missionSnap.exists || missionSnap.data()?.phase === "cleared" || !missionSnap.data()?.sosId) {
          return { status: "no-active-mission" };
        }
        tx.update(missionRef, { phase: "cleared", clearedAt: now, clearedBy: "admin" });
        return { status: "cleared", mission: { ...missionSnap.data(), phase: "cleared", clearedAt: now } };
      });
    }
    const { doc, runTransaction } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any): Promise<MissionClearResult> => {
      const missionRef = doc(db, "teamMissions", teamId);
      const missionSnap = await tx.get(missionRef);
      if (!missionSnap.exists() || missionSnap.data()?.phase === "cleared" || !missionSnap.data()?.sosId) {
        return { status: "no-active-mission" };
      }
      tx.update(missionRef, { phase: "cleared", clearedAt: now, clearedBy: "admin" });
      return { status: "cleared", mission: { ...missionSnap.data(), phase: "cleared", clearedAt: now } };
    });
  } catch (err) {
    logger.error({ err, teamId }, "Atomic mission clear failed");
    return { status: "unavailable" };
  }
}

export type PrincipalBlockResult = "blocked" | "unblocked" | "missing" | "unavailable";

/**
 * B2 device blocking: add/remove a principal on the team's blocklist. A
 * REMOVED member's device keeps its public principal (cookie) forever —
 * tokenGen revocation kills its token, but with a live join code it could
 * still mint a fresh one. A blocked principal is rejected INSIDE the join
 * transaction (joinTeamAtomically), so no route race can re-enroll it.
 * Read-modify-write inside one transaction keeps the list collision-free
 * against concurrent block/unblock calls.
 */
export async function setPrincipalBlocked(
  teamId: string,
  principal: string,
  blocked: boolean
): Promise<PrincipalBlockResult> {
  const db = getDb();
  if (!db) return "unavailable";
  try {
    if (isAdminDb(db)) {
      return await db.runTransaction(async (tx: any): Promise<PrincipalBlockResult> => {
        const teamRef = db.collection("teams").doc(teamId);
        const teamSnap = await tx.get(teamRef);
        if (!teamSnap.exists) return "missing";
        const data = teamSnap.data() || {};
        const current: string[] = Array.isArray(data.blockedPrincipals)
          ? data.blockedPrincipals.filter((p: unknown) => typeof p === "string")
          : [];
        if (blocked && current.includes(principal)) return "blocked"; // idempotent
        if (!blocked && !current.includes(principal)) return "unblocked"; // idempotent
        const next = blocked ? [...current, principal] : current.filter((p) => p !== principal);
        tx.update(teamRef, { blockedPrincipals: next });
        return blocked ? "blocked" : "unblocked";
      });
    }
    const { doc, runTransaction } = await import("firebase/firestore");
    return await runTransaction(db, async (tx: any): Promise<PrincipalBlockResult> => {
      const teamRef = doc(db, "teams", teamId);
      const teamSnap = await tx.get(teamRef);
      if (!teamSnap.exists()) return "missing";
      const data = teamSnap.data() || {};
      const current: string[] = Array.isArray(data.blockedPrincipals)
        ? data.blockedPrincipals.filter((p: unknown) => typeof p === "string")
        : [];
      if (blocked && current.includes(principal)) return "blocked";
      if (!blocked && !current.includes(principal)) return "unblocked";
      const next = blocked ? [...current, principal] : current.filter((p) => p !== principal);
      tx.update(teamRef, { blockedPrincipals: next });
      return blocked ? "blocked" : "unblocked";
    });
  } catch (err) {
    logger.error({ err, teamId, principal: "[principal]" }, "Atomic principal block update failed");
    return "unavailable";
  }
}
