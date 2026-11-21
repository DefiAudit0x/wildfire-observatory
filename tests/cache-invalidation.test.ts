import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Ref = { collection: string; id: string };
const backend = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  const state = { admin: true, failCommit: false, reads: 0, commits: 0, readGate: null as Promise<void> | null };
  const key = (ref: Ref) => `${ref.collection}/${ref.id}`;
  const snapshot = (ref: Ref) => {
    const value = rows.get(key(ref));
    return { empty: ![...rows.keys()].some((path) => path.startsWith(`${ref.collection}/`)), id: ref.id, exists: state.admin ? value !== undefined : () => value !== undefined, data: () => value && structuredClone(value) };
  };
  const write = (ref: Ref, data: Row, merge = false) => {
    const previous = rows.get(key(ref)) || {};
    const values = Object.fromEntries(Object.entries(data).map(([field, value]) => [field,
      value && typeof value === "object" && "increment" in value
        ? Number(previous[field] || 0) + Number(value.increment) : value]));
    rows.set(key(ref), structuredClone(merge ? { ...previous, ...values } : values));
  };
  const query = (name: string) => ({
    collection: name,
    orderBy: () => query(name), limit: () => query(name), where: () => query(name),
    doc: (id: string) => ({ collection: name, id, get: async () => { state.reads++; const snap = snapshot({ collection: name, id }); if (state.readGate) await state.readGate; return snap; }, set: async (data: Row) => write({ collection: name, id }, data) }),
    get: async () => {
      state.reads++;
      const docs = [...rows.keys()].filter((path) => path.startsWith(`${name}/`)).map((path) => snapshot({ collection: name, id: path.slice(name.length + 1) }));
      // Fix 10b: the snapshot is taken before the gate — this models a read
      // that executed before a write but whose response arrives after the
      // invalidation. Awaiting the gate first would read post-write data
      // and never exercise the race.
      if (state.readGate) await state.readGate;
      return { empty: !docs.length, docs };
    },
  });
  type Tx = { get: (ref: Ref) => Promise<ReturnType<typeof snapshot>>; set: (ref: Ref, data: Row, options?: { merge: boolean }) => void; create: (ref: Ref, data: Row) => void; update: (ref: Ref, data: Row) => void; delete: (ref: Ref) => void };
  const runTransaction = async <T>(callback: (tx: Tx) => Promise<T>) => {
    const writes: (() => void)[] = [];
    const result = await callback({
      get: async (ref) => snapshot(ref),
      set: (ref, data, options) => { writes.push(() => write(ref, data, options?.merge)); },
      create: (ref, data) => { writes.push(() => write(ref, data)); },
      update: (ref, data) => { writes.push(() => write(ref, data, true)); },
      delete: (ref) => { writes.push(() => { rows.delete(key(ref)); }); },
    });
    if (state.failCommit) throw new Error("commit failed");
    writes.forEach((write) => write());
    state.commits += writes.length;
    return result;
  };
  return { rows, state, snapshot, query, write, runTransaction, db: { collection: query, runTransaction } };
});
vi.mock("../server/firebase.js", () => ({ getDb: () => backend.db, isAdminDb: () => backend.state.admin }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { increment: (increment: number) => ({ increment }) } }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, collection: string, id: string) => ({ collection, id }),
  collection: (_db: unknown, name: string) => backend.query(name),
  getDoc: async (ref: Ref) => { backend.state.reads++; const snap = backend.snapshot(ref); if (backend.state.readGate) await backend.state.readGate; return snap; },
  getDocFromServer: async (ref: Ref) => { backend.state.reads++; const snap = backend.snapshot(ref); if (backend.state.readGate) await backend.state.readGate; return snap; },
  getDocs: (ref: ReturnType<typeof backend.query>) => ref.get(),
  setDoc: async (ref: Ref, data: Row) => backend.write(ref, data),
  query: (ref: unknown) => ref, orderBy: () => ({}), limit: () => ({}), where: () => ({}),
  increment: (increment: number) => ({ increment }),
  runTransaction: (_db: unknown, callback: Parameters<typeof backend.runTransaction>[0]) => backend.runTransaction(callback),
}));

for (const admin of [true, false]) describe(`${admin ? "admin" : "client"} SDK real cache invalidation`, () => {
  let fs: typeof import("../server/fs.js");
  let atomic: typeof import("../server/atomic.js");
  beforeEach(async () => {
    vi.resetModules();
    backend.rows.clear();
    Object.assign(backend.state, { admin, failCommit: false, reads: 0, commits: 0, readGate: null });
    fs = await import("../server/fs.js");
    atomic = await import("../server/atomic.js");
  });
  const seed = (collection: string, id: string, data: Row) => backend.rows.set(`${collection}/${id}`, data);
  const prime = async (collection: string, id: string) => {
    await fs.docGet(collection, id);
    await fs.collectionGet(collection);
  };
  const fresh = async (collection: string, id: string) => {
    expect(await fs.docGet(collection, id)).toEqual(backend.rows.has(`${collection}/${id}`) ? { id, ...backend.rows.get(`${collection}/${id}`) } : null);
    expect(await fs.collectionGet(collection)).toEqual([...backend.rows.entries()].filter(([key]) => key.startsWith(`${collection}/`)).map(([key, data]) => ({ id: key.slice(collection.length + 1), ...data })));
  };
  it("FS-1 clears default, ordered and limited snapshots while preserving other collections", async () => {
    seed("test", "one", { value: 1 });
    seed("testOther", "one", { value: 7 });
    await fs.collectionGet("testOther");
    for (const [order, limit] of [[undefined, undefined], ["value", undefined], [undefined, 1], ["value", 1]] as const) {
      expect(await fs.collectionGet("test", order, limit)).toEqual([{ id: "one", value: 1 }]);
    }
    expect(await fs.docSet("test", "one", { value: 2 })).toBe(true);
    for (const [order, limit] of [[undefined, undefined], ["value", undefined], [undefined, 1], ["value", 1]] as const) {
      expect(await fs.collectionGet("test", order, limit)).toEqual([{ id: "one", value: 2 }]);
    }
    const reads = backend.state.reads;
    await fs.collectionGet("testOther");
    expect(backend.state.reads).toBe(reads);
  });
  it("ATM-2 clears a new roster day's cached null", async () => {
    expect(await fs.docGet("rosters", "day")).toBeNull();
    await fs.collectionGet("rosters");
    expect(await atomic.appendRosterPostAtomic("rosters", "day", "unit", { personnel: [{ agentId: "a" }] }, 4)).toBe("created");
    await fresh("rosters", "day");
  });
  it("ATM-2 clears an existing roster day's prior posts", async () => {
    seed("rosters", "day", { posts: [{ personnel: [{ agentId: "a" }] }] });
    await prime("rosters", "day");
    expect(await atomic.appendRosterPostAtomic("rosters", "day", "unit", { personnel: [{ agentId: "b" }] }, 4)).toBe("created");
    await fresh("rosters", "day");
  });
  it("ATM-2 clears unit create precheck null", async () => {
    expect(await fs.docGet("units", "unit")).toBeNull();
    await fs.collectionGet("units");
    expect(await atomic.createDocIfAbsent("units", "unit", { name: "Unit" })).toBe("created");
    await fresh("units", "unit");
  });
  it("ATM-2 clears newly created staff", async () => {
    seed("units", "unit", {});
    await prime("users", "agent");
    expect(await atomic.createUserIfUnitExists("agent", "unit", { unitId: "unit" })).toBe("created");
    await fresh("users", "agent");
  });
  it("ATM-2 clears deleted units", async () => {
    // No user rows: the query is empty in either SDK.
    seed("units", "unit", {});
    await prime("units", "unit");
    expect(await atomic.deleteUnitIfUnlinked("unit")).toBe("deleted");
    await fresh("units", "unit");
  });
  it("ATM-2 clears registration and all uniqueness reservations", async () => {
    const ids = ["phone-p", "email-e", "name-n:16"];
    await prime("volunteerRegistrations", "reg");
    for (const id of ids) await prime("volunteerRegistrationUniqueness", id);
    expect(await atomic.createVolunteerRegistrationAtomically({ id: "reg", wilaya: "16" }, { phoneHash: "p", emailHash: "e", fullNameHash: "n" })).toBe("created");
    await fresh("volunteerRegistrations", "reg");
    for (const id of ids) await fresh("volunteerRegistrationUniqueness", id);
  });
  it("ATM-2 clears badge precheck null and approval's prior registration", async () => {
    seed("volunteerRegistrations", "reg", { status: "pending" });
    await prime("volunteerRegistrations", "reg");
    await prime("badgeCodes", "badge");
    expect(await atomic.approveVolunteerAtomically("reg", { status: "approved" }, "badge", { active: true })).toBe("updated");
    await fresh("volunteerRegistrations", "reg");
    await fresh("badgeCodes", "badge");
  });
  it("ATM-2 clears join member and code budget", async () => {
    seed("teamJoinCodes", "code", { teamId: "team", uses: 0, maxUses: 2 });
    seed("teams", "team", { active: true });
    await prime("teamJoinCodes", "code");
    await prime("teamMembers", "member");
    expect((await atomic.joinTeamAtomically("code", "member", { principal: "p" })).status).toBe("joined");
    await fresh("teamJoinCodes", "code");
    await fresh("teamMembers", "member");
  });
  for (const operation of ["phase", "clear"] as const) it(`ATM-2 clears mission ${operation}`, async () => {
    seed("teamMissions", "team", { phase: "en_route", sosId: "sos", since: 1 });
    await prime("teamMissions", "team");
    const result = operation === "phase" ? await atomic.setMissionPhaseAtomically("team", "on_scene") : await atomic.clearTeamMissionAtomically("team");
    expect(result.status).toBe(operation === "phase" ? "updated" : "cleared");
    await fresh("teamMissions", "team");
  });
  it("ATM-2 clears principal block and unblock writes", async () => {
    seed("teams", "team", { blockedPrincipals: [] });
    for (const blocked of [true, false]) {
      await prime("teams", "team");
      expect(await atomic.setPrincipalBlocked("team", "p", blocked)).toBe(blocked ? "blocked" : "unblocked");
      await fresh("teams", "team");
    }
  });
  it("Fix 10b: a pending collection read cannot restore invalidated data", async () => {
    seed("test", "one", { value: 1 });
    let release!: () => void;
    backend.state.readGate = new Promise<void>((resolve) => { release = resolve; });
    const pending = fs.collectionGet("test");
    // Let the read reach the gated backend call (the client SDK path awaits
    // a dynamic import first); the gate itself is still held, so the read
    // cannot have passed it. The reads counter proves it is in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.state.reads).toBe(1);
    // The read has entered the gated backend call; a writer commits and
    // invalidates while its response is still in flight.
    expect(await fs.docSet("test", "one", { value: 2 })).toBe(true);
    release();
    // The pending call itself still returns its pre-write snapshot — that
    // is unavoidable — but it must NOT re-cache it.
    expect(await pending).toEqual([{ id: "one", value: 1 }]);
    expect(await fs.collectionGet("test")).toEqual([{ id: "one", value: 2 }]);
  });
  it("Fix 10b: a pending doc read cannot restore invalidated data", async () => {
    seed("test", "one", { value: 1 });
    let release!: () => void;
    backend.state.readGate = new Promise<void>((resolve) => { release = resolve; });
    const pending = fs.docGet("test", "one");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.state.reads).toBe(1);
    expect(await fs.docSet("test", "one", { value: 2 })).toBe(true);
    release();
    expect(await pending).toEqual({ id: "one", value: 1 });
    expect(await fs.docGet("test", "one")).toEqual({ id: "one", value: 2 });
  });
  it("preserves caches on exists, missing, unavailable and idempotent no-write outcomes", async () => {
    seed("units", "unit", {});
    seed("teams", "team", { blockedPrincipals: ["p"] });
    await prime("units", "unit");
    await prime("teams", "team");
    await prime("users", "agent");
    expect(await atomic.createDocIfAbsent("units", "unit", {})).toBe("exists");
    expect(await atomic.createUserIfUnitExists("agent", "missing", {})).toBe("unit-missing");
    expect(await atomic.setPrincipalBlocked("team", "p", true)).toBe("blocked");
    expect(await atomic.setPrincipalBlocked("team", "absent", false)).toBe("unblocked");
    backend.state.failCommit = true;
    expect(await atomic.createUserIfUnitExists("agent", "unit", {})).toBe("unavailable");
    const reads = backend.state.reads;
    await prime("units", "unit");
    await prime("teams", "team");
    await prime("users", "agent");
    expect(backend.state.reads).toBe(reads);
    expect(backend.state.commits).toBe(0);
  });
});
