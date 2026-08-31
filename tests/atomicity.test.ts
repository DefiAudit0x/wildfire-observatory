import { describe, expect, it, vi } from "vitest";

type Doc = Record<string, any>;
type State = { docs: Map<string, Doc>; queue: Promise<void> };
const state = vi.hoisted<State>(() => ({ docs: new Map(), queue: Promise.resolve() }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => createDb(),
  isAdminDb: () => true,
}));

// Sentinel stand-ins for the real FieldValue class so the fake harness can
// resolve arrayUnion/increment writes exactly like Firestore would.
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    arrayUnion: (...values: any[]) => ({ __op: "arrayUnion", values }),
    increment: (amount: number) => ({ __op: "increment", amount }),
  },
}));

function snapshot(path: string) {
  const data = state.docs.get(path);
  return { exists: Boolean(data), id: path.split("/").at(-1), data: () => data };
}

function resolveSentinel(old: any, value: any): any {
  if (value && typeof value === "object" && (value as any).__op === "arrayUnion") {
    return [...(Array.isArray(old) ? old : []), ...((value as any).values ?? [])];
  }
  if (value && typeof value === "object" && (value as any).__op === "increment") {
    return (Number(old) || 0) + (value as any).amount;
  }
  return value;
}

/** Firestore update/merge-set semantics: listed fields change, siblings survive. */
function applyMerge(old: Doc | undefined, data: Doc): Doc {
  const out: Doc = { ...(old || {}) };
  for (const [k, v] of Object.entries(data)) out[k] = resolveSentinel(out[k], v);
  return out;
}

type Write = { kind: "create" | "set" | "update"; path: string; data: Doc; merge?: boolean };

function applyWrite(write: Write) {
  const old = state.docs.get(write.path);
  if (write.kind === "update" || (write.kind === "set" && write.merge)) {
    state.docs.set(write.path, applyMerge(old, write.data));
  } else {
    state.docs.set(write.path, write.data);
  }
}

function createDb() {
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          const path = `${name}/${id}`;
          return {
            id,
            path,
            get: async () => snapshot(path),
            // Direct (non-tx) writes — exercised by fs.ts docSet/docMergeSet/docUpdate.
            set: async (data: Doc, opts?: { merge?: boolean }) => applyWrite({ kind: "set", path, data, merge: Boolean(opts?.merge) }),
            update: async (data: Doc) => applyWrite({ kind: "update", path, data }),
            delete: async () => {
              state.docs.delete(path);
            },
          };
        },
      };
    },
    async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      const previous = state.queue;
      let release!: () => void;
      state.queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const writes: Write[] = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        create: (ref: { path: string }, data: Doc) => writes.push({ kind: "create", path: ref.path, data }),
        set: (ref: { path: string }, data: Doc, opts?: { merge?: boolean }) =>
          writes.push({ kind: "set", path: ref.path, data, merge: Boolean(opts?.merge) }),
        update: (ref: { path: string }, data: Doc) => writes.push({ kind: "update", path: ref.path, data }),
      };
      try {
        const result = await callback(tx);
        for (const write of writes) applyWrite(write);
        return result;
      } finally {
        release();
      }
    },
  };
}

const {
  createDocIfAbsent,
  appendRosterPostAtomic,
  approveVolunteerAtomically,
  createVolunteerRegistrationAtomically,
  joinTeamAtomically,
} = await import("../server/atomic.js");
const { docMergeSet, docSet, appendSosDispatch } = await import("../server/fs.js");

const post = (id: string) => ({ id, labelAr: id, personnel: [] });
const registration = (id: string) => ({ id, status: "pending", wilaya: "Bordj Bou Arreridj", createdAt: "2026-08-24T00:00:00.000Z" });
const uniquenessKeys = { phoneHash: "phone-hash", emailHash: "email-hash", fullNameHash: "name-hash" };

describe("atomic persistence helpers", () => {
  it("allows only one concurrent create for a unique document", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const [first, second] = await Promise.all([
      createDocIfAbsent("users", "agent-atomic", { agentId: "agent-atomic" }),
      createDocIfAbsent("users", "agent-atomic", { agentId: "agent-atomic" }),
    ]);
    expect([first, second].sort()).toEqual(["created", "exists"]);
    expect(state.docs.get("users/agent-atomic")).toEqual({ agentId: "agent-atomic" });
  });

  it("preserves both concurrent roster appends instead of losing the last writer", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const first = appendRosterPostAtomic("units/unit-dz16/rosterDays", "2026-08-24", "unit-dz16", post("post-a"), 50);
    const second = appendRosterPostAtomic("units/unit-dz16/rosterDays", "2026-08-24", "unit-dz16", post("post-b"), 50);
    const results = await Promise.all([first, second]);
    expect(results).toEqual(["created", "created"]);
    expect(state.docs.get("units/unit-dz16/rosterDays/2026-08-24")?.posts.map((p: any) => p.id)).toEqual(["post-a", "post-b"]);
  });

  it("does not allow a concurrent roster append to exceed the post limit", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("units/unit-dz16/rosterDays/2026-08-24", { unitId: "unit-dz16", date: "2026-08-24", posts: [post("last-slot")] });
    const [first, second] = await Promise.all([
      appendRosterPostAtomic("units/unit-dz16/rosterDays", "2026-08-24", "unit-dz16", post("post-a"), 2),
      appendRosterPostAtomic("units/unit-dz16/rosterDays", "2026-08-24", "unit-dz16", post("post-b"), 2),
    ]);
    expect([first, second].filter((x) => x === "created")).toHaveLength(1);
    expect([first, second].filter((x) => x === "limit")).toHaveLength(1);
  });

  it("atomically creates only one registration for concurrent identical uniqueness keys", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const [first, second] = await Promise.all([
      createVolunteerRegistrationAtomically(registration("reg-a"), uniquenessKeys),
      createVolunteerRegistrationAtomically(registration("reg-b"), uniquenessKeys),
    ]);
    expect([first, second].sort()).toEqual(["created", "duplicate-phone"]);
    expect(state.docs.has("volunteerRegistrations/reg-a")).not.toBe(state.docs.has("volunteerRegistrations/reg-b"));
    expect(state.docs.get("volunteerRegistrationUniqueness/phone-phone-hash")).toMatchObject({ registrationId: expect.any(String), kind: "phone" });
  });

  it("releases uniqueness after a rejected registration", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("volunteerRegistrationUniqueness/phone-phone-hash", { registrationId: "reg-rejected", kind: "phone" });
    state.docs.set("volunteerRegistrationUniqueness/email-email-hash", { registrationId: "reg-rejected", kind: "email" });
    state.docs.set("volunteerRegistrationUniqueness/name-name-hash:Bordj Bou Arreridj", { registrationId: "reg-rejected", kind: "name" });
    state.docs.set("volunteerRegistrations/reg-rejected", { ...registration("reg-rejected"), status: "rejected" });
    const result = await createVolunteerRegistrationAtomically(registration("reg-new"), uniquenessKeys);
    expect(result).toBe("created");
    expect(state.docs.get("volunteerRegistrationUniqueness/phone-phone-hash")?.registrationId).toBe("reg-new");
  });

  it("allows the same name and wilaya after the 30-day window expires", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const oldCreatedAt = "2026-07-01T00:00:00.000Z";
    state.docs.set("volunteerRegistrationUniqueness/phone-old-phone", { registrationId: "reg-old-phone", kind: "phone", createdAt: oldCreatedAt });
    state.docs.set("volunteerRegistrationUniqueness/name-name-hash:Bordj Bou Arreridj", {
      registrationId: "reg-old-name",
      kind: "name",
      createdAt: oldCreatedAt,
      expiresAt: Date.now() - 1,
    });
    state.docs.set("volunteerRegistrations/reg-old-phone", { id: "reg-old-phone", status: "pending" });
    state.docs.set("volunteerRegistrations/reg-old-name", { id: "reg-old-name", status: "pending", createdAt: oldCreatedAt, wilaya: "Bordj Bou Arreridj" });
    const result = await createVolunteerRegistrationAtomically(
      registration("reg-new-window"),
      { phoneHash: "new-phone", fullNameHash: "name-hash" },
    );
    expect(result).toBe("created");
  });

  it("atomically approves a volunteer with its badge", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("volunteerRegistrations/reg-atomic", { id: "reg-atomic", status: "pending" });
    const result = await approveVolunteerAtomically(
      "reg-atomic",
      { status: "approved", assignedCode: "VOLATOMIC" },
      "VOLATOMIC",
      { code: "VOLATOMIC", isActive: true },
    );
    expect(result).toBe("updated");
    expect(state.docs.get("volunteerRegistrations/reg-atomic")).toMatchObject({ status: "approved", assignedCode: "VOLATOMIC" });
    expect(state.docs.get("badgeCodes/VOLATOMIC")).toMatchObject({ code: "VOLATOMIC", isActive: true });
  });

  it("leaves the registration unchanged when the badge code wins a concurrent race", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("volunteerRegistrations/reg-a", { id: "reg-a", status: "pending" });
    state.docs.set("volunteerRegistrations/reg-b", { id: "reg-b", status: "pending" });
    const [first, second] = await Promise.all([
      approveVolunteerAtomically("reg-a", { status: "approved", assignedCode: "RACE01" }, "RACE01", { code: "RACE01" }),
      approveVolunteerAtomically("reg-b", { status: "approved", assignedCode: "RACE01" }, "RACE01", { code: "RACE01" }),
    ]);
    expect([first, second].sort()).toEqual(["badge-exists", "updated"]);
    const approved = [state.docs.get("volunteerRegistrations/reg-a"), state.docs.get("volunteerRegistrations/reg-b")].filter((r) => r?.status === "approved");
    expect(approved).toHaveLength(1);
  });
});

describe("ARC-R1 — merge snapshots never destroy sibling fields", () => {
  it("docMergeSet touches only the listed fields and preserves join-time authority fields", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("teamMembers/tm-r1", {
      memberId: "tm-r1",
      teamId: "team-a1",
      principal: "principal-xyz",
      joinedAt: 111,
      rejoinCount: 2,
      active: true,
    });
    await docMergeSet("teamMembers", "tm-r1", {
      memberId: "tm-r1",
      teamId: "team-a1",
      name: "عضو",
      lastKnownLat: 36.7,
      lastKnownLng: 5.0,
      lastSeenAt: 999,
    });
    expect(state.docs.get("teamMembers/tm-r1")).toEqual({
      memberId: "tm-r1",
      teamId: "team-a1",
      name: "عضو",
      principal: "principal-xyz",
      joinedAt: 111,
      rejoinCount: 2,
      active: true,
      lastKnownLat: 36.7,
      lastKnownLng: 5.0,
      lastSeenAt: 999,
    });
  });

  it("docSet stays a full replacement — the resurrect-by-snapshot shape, pinned deliberately", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("teamMembers/tm-r2", { memberId: "tm-r2", principal: "p", active: false });
    await docSet("teamMembers", "tm-r2", { memberId: "tm-r2", lastKnownLat: 1, lastSeenAt: 2 });
    expect(state.docs.get("teamMembers/tm-r2")).toEqual({ memberId: "tm-r2", lastKnownLat: 1, lastSeenAt: 2 });
  });
});

describe("ARC-R4 — dispatch idempotency under same-team/same-SOS re-entry", () => {
  const sosRow = (tag: string) => ({
    teamId: "team-r4",
    type: "volunteers",
    teamNameAr: "فريق",
    teamNameFr: "T",
    status: "en_route",
    notes: tag,
    dispatchedAt: Date.now(),
  });

  function seed(kind: "en_route" | "on_scene" | "cleared" | "other-sos") {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("trappedSos/sos-r4", { id: "sos-r4", status: "active", dispatchedTeams: [sosRow("first")] });
    state.docs.set("teamMissions/team-r4", {
      teamId: "team-r4",
      sosId: kind === "other-sos" ? "sos-OTHER" : "sos-r4",
      phase: kind === "other-sos" ? "en_route" : kind,
      since: 1000,
    });
  }

  it("accepts a same-SOS re-dispatch as ok WITHOUT duplicating rows or regressing on_scene", async () => {
    seed("on_scene");
    const result = await appendSosDispatch("sos-r4", sosRow("second"), "team-r4");
    expect(result).toBe("ok");
    const mission = state.docs.get("teamMissions/team-r4")!;
    expect(mission.phase).toBe("on_scene");
    expect(mission.since).toBe(1000);
    expect(state.docs.get("trappedSos/sos-r4")!.dispatchedTeams).toHaveLength(1);
  });

  it("keeps en_route en_route with a single dispatch row under an operator double-click", async () => {
    seed("en_route");
    const result = await appendSosDispatch("sos-r4", sosRow("second"), "team-r4");
    expect(result).toBe("ok");
    const mission = state.docs.get("teamMissions/team-r4")!;
    expect(mission.phase).toBe("en_route");
    expect(mission.since).toBe(1000);
    expect(state.docs.get("trappedSos/sos-r4")!.dispatchedTeams).toHaveLength(1);
  });

  it("still refuses a DIFFERENT sos with team_busy while the mission is active", async () => {
    seed("other-sos");
    const result = await appendSosDispatch("sos-r4", sosRow("second"), "team-r4");
    expect(result).toBe("team_busy");
    expect(state.docs.get("trappedSos/sos-r4")!.dispatchedTeams).toHaveLength(1);
  });

  it("allows a genuine re-dispatch after the mission was cleared (fresh en_route + since)", async () => {
    seed("cleared");
    const result = await appendSosDispatch("sos-r4", sosRow("second"), "team-r4");
    expect(result).toBe("ok");
    const mission = state.docs.get("teamMissions/team-r4")!;
    expect(mission.phase).toBe("en_route");
    expect(mission.since).toBeGreaterThan(1000);
    expect(state.docs.get("trappedSos/sos-r4")!.dispatchedTeams).toHaveLength(2);
  });
});

describe("Team join transaction — real-logic coverage (ARC-T1 first slice)", () => {
  it("resolves two devices racing the LAST code use to exactly one winner", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("teamJoinCodes/RACECOD1", {
      code: "RACECOD1",
      teamId: "team-race",
      expiresAt: Date.now() + 3_600_000,
      maxUses: 1,
      uses: 0,
      revoked: false,
    });
    state.docs.set("teams/team-race", { teamId: "team-race", active: true });
    const [a, b] = await Promise.all([
      joinTeamAtomically("RACECOD1", "tm-aaaaaaaaaaaaaaaa", { memberId: "tm-aaaaaaaaaaaaaaaa", teamId: "team-race", name: "أ", principal: "p-a" }),
      joinTeamAtomically("RACECOD1", "tm-bbbbbbbbbbbbbbbb", { memberId: "tm-bbbbbbbbbbbbbbbb", teamId: "team-race", name: "ب", principal: "p-b" }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["code-exhausted", "joined"]);
    expect(state.docs.get("teamJoinCodes/RACECOD1")!.uses).toBe(1);
  });

  it("rejoin preserves the original joinedAt and reactivates (merge upsert)", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("teamJoinCodes/REJOINC1", {
      code: "REJOINC1",
      teamId: "team-rj",
      expiresAt: Date.now() + 3_600_000,
      maxUses: 10,
      uses: 0,
      revoked: false,
    });
    state.docs.set("teams/team-rj", { teamId: "team-rj", active: true });
    state.docs.set("teamMembers/tm-rejoin00000001", {
      memberId: "tm-rejoin00000001",
      teamId: "team-rj",
      principal: "p",
      joinedAt: 555,
      active: false,
    });
    const r = await joinTeamAtomically("REJOINC1", "tm-rejoin00000001", { memberId: "tm-rejoin00000001", teamId: "team-rj", name: "ن", principal: "p" });
    expect(r.status).toBe("joined");
    const member = state.docs.get("teamMembers/tm-rejoin00000001")!;
    expect(member.joinedAt).toBe(555);
    expect(member.active).toBe(true);
    expect(member.rejoinCount).toBe(1);
  });

  it("rejects a revoked code and never touches the budget", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("teamJoinCodes/REVOKED1", {
      code: "REVOKED1",
      teamId: "team-rv",
      expiresAt: Date.now() + 3_600_000,
      maxUses: 5,
      uses: 0,
      revoked: true,
    });
    state.docs.set("teams/team-rv", { teamId: "team-rv", active: true });
    const r = await joinTeamAtomically("REVOKED1", "tm-rv0000000000001", { memberId: "tm-rv0000000000001", teamId: "team-rv", name: "خ", principal: "p" });
    expect(r.status).toBe("code-invalid");
    expect(state.docs.get("teamJoinCodes/REVOKED1")!.uses).toBe(0);
    expect(state.docs.has("teamMembers/tm-rv0000000000001")).toBe(false);
  });
});
