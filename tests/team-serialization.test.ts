import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

type Data = Record<string, unknown>;
type Ref = { path: string };
type Write = { ref: Ref; data?: Data; kind: "update" | "set" | "delete" };
const state = vi.hoisted(() => ({
  admin: true, docs: new Map<string, Data>(), failPath: "",
  collectionGate: null as null | (() => Promise<void>),
  missionGate: null as null | (() => Promise<void>),
  gpsGate: null as null | (() => Promise<void>),
  mintGate: null as null | (() => Promise<void>),
  gpsDone: null as null | (() => void),
}));
const deletion = { __delete: true };
function snapshot(ref: Ref) {
  const data = state.docs.get(ref.path);
  return { id: ref.path.split("/")[1], exists: state.admin ? Boolean(data) : () => Boolean(data), data: () => data && { ...data } };
}
function apply(write: Write) {
  if (write.kind === "delete") { state.docs.delete(write.ref.path); return; }
  const next = write.kind === "update" ? { ...state.docs.get(write.ref.path) } : {};
  for (const [key, value] of Object.entries(write.data || {})) {
    if (value && typeof value === "object" && "__delete" in value) delete next[key];
    else next[key] = value;
  }
  state.docs.set(write.ref.path, next);
}
async function transaction(_db: unknown, callback: (tx: unknown) => Promise<unknown>): Promise<unknown> {
  let positionTransaction = false;
  for (;;) {
    const reads = new Map<string, string | undefined>();
    const writes: Write[] = [];
    const tx = {
      get: async (ref: Ref) => {
        if (writes.length) throw new Error("Read after write");
        reads.set(ref.path, JSON.stringify(state.docs.get(ref.path)));
        return read(ref);
      },
      update: (ref: Ref, data: Data) => writes.push({ ref, data, kind: "update" }),
      set: (ref: Ref, data: Data) => writes.push({ ref, data, kind: "set" }),
      create: (ref: Ref, data: Data) => writes.push({ ref, data, kind: "set" }),
      delete: (ref: Ref) => writes.push({ ref, kind: "delete" }),
    };
    const result = await callback(tx);
    if (writes.some((w) => w.ref.path.startsWith("teamJoinCodes/") && w.data?.revoked === false) && state.mintGate) {
      const gate = state.mintGate; state.mintGate = null; await gate();
    }
    const gps = writes.some((w) => typeof w.data?.lastKnownLat === "number");
    positionTransaction ||= gps;
    if (gps && state.gpsGate) { const gate = state.gpsGate; state.gpsGate = null; await gate(); }
    if ([...reads].some(([path, old]) => JSON.stringify(state.docs.get(path)) !== old)) continue;
    if (writes.some((w) => w.ref.path === state.failPath)) throw new Error("Commit rejected");
    writes.forEach(apply);
    if (positionTransaction) { state.gpsDone?.(); state.gpsDone = null; }
    return result;
  }
}
async function read(ref: Ref) {
  const snap = snapshot(ref);
  if (ref.path.startsWith("teamMissions/") && state.missionGate) {
    const gate = state.missionGate; state.missionGate = null; await gate();
  }
  return snap;
}
async function scan(ref: Ref) {
  const docs = [...state.docs.keys()].filter((path) => path.startsWith(`${ref.path}/`)).map((path) => snapshot({ path }));
  if (state.collectionGate && ref.path === "teamJoinCodes") await state.collectionGate();
  return { empty: !docs.length, docs };
}
async function update(ref: Ref, data: Data) {
  if (ref.path === state.failPath) throw new Error("Write rejected");
  apply({ ref, data, kind: "update" });
}
async function set(ref: Ref, data: Data, options?: { merge?: boolean }) {
  if (ref.path.startsWith("teamJoinCodes/") && state.mintGate) { const gate = state.mintGate; state.mintGate = null; await gate(); }
  const gps = typeof data.lastKnownLat === "number";
  if (gps && state.gpsGate) { const gate = state.gpsGate; state.gpsGate = null; await gate(); }
  apply({ ref, data, kind: options?.merge ? "update" : "set" });
  if (gps) { state.gpsDone?.(); state.gpsDone = null; }
}
const db = {
  collection: (name: string) => ({
    get: () => scan({ path: name }),
    doc: (id: string) => {
      const ref = { path: `${name}/${id}` };
      return { ...ref, get: () => read(ref), update: (data: Data) => update(ref, data), set: (data: Data, opts?: { merge?: boolean }) => set(ref, data, opts) };
    },
  }),
  runTransaction: (callback: (tx: unknown) => Promise<unknown>) => transaction(db, callback),
};
vi.mock("../server/firebase.js", () => ({ getDb: () => db, isAdminDb: () => state.admin }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { delete: () => deletion } }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, name: string, id: string) => ({ path: `${name}/${id}` }),
  collection: (_db: unknown, name: string) => ({ path: name }),
  getDoc: read, getDocFromServer: read, getDocs: scan, updateDoc: update, setDoc: set,
  query: (ref: Ref) => ref, orderBy: () => null, limit: () => null,
  runTransaction: transaction, deleteField: () => deletion,
}));
// Resolve the lazy SDK module before concurrent requests enter it.
await import("firebase/firestore");
const { default: router } = await import("../server/routes/teams.js");
const { generateAdminToken } = await import("../server/middleware.js");
const { createTeamMemberToken } = await import("../server/teamAuth.js");
const fs = await import("../server/fs.js");
const registry = await import("../server/teamRegistry.js");
const app = express();
app.set("trust proxy", 1); app.use(express.json()); app.use("/api/teams", router);
let sequence = 0;
let member = "";
const team = "team-serialized";
function request(method: "post" | "delete", path: string, admin = false) {
  sequence += 1;
  return supertest(app)[method](`/api/teams/${path}`)
    .set("X-Forwarded-For", `10.89.${Math.floor(sequence / 250)}.${sequence % 250 + 1}`)
    .set("authorization", `Bearer ${admin ? generateAdminToken() : createTeamMemberToken(member, team)}`);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function liveCodes() { return [...state.docs.entries()].filter(([path, data]) => path.startsWith("teamJoinCodes/") && data.revoked !== true); }
function ping() { registry.recordHeartbeat({ memberId: member, teamId: team, name: "Member", lat: 36.75, lng: 5.07 }); }

beforeEach(() => {
  state.docs.clear(); state.failPath = ""; state.collectionGate = null; state.missionGate = null; state.gpsGate = null; state.gpsDone = null; state.mintGate = null;
  registry.clearRegistry();
  fs.invalidateDocCache("teamMissions", team);
  fs.invalidateDocCache("teams", team);
  for (const name of ["teams", "teamMembers", "teamJoinCodes", "teamMissions"]) fs.invalidateCollectionCache(name);
  member = `tm-${(++sequence).toString(16).padStart(16, "0")}`;
  state.docs.set(`teams/${team}`, { teamId: team, active: true });
  state.docs.set(`teamMembers/${member}`, { memberId: member, teamId: team, active: true, tokenGen: 0, name: "Member" });
});

for (const admin of [true, false]) describe(`Fix 14 real routes and registry — ${admin ? "Admin" : "client"} SDK`, () => {
  beforeEach(() => { state.admin = admin; });
  it("failed old-code revoke returns 503 and leaves only the old code live", async () => {
    state.docs.set("teamJoinCodes/OLDLIVE1", { code: "OLDLIVE1", teamId: team, revoked: false, expiresAt: Date.now() + 60_000 });
    state.failPath = "teamJoinCodes/OLDLIVE1";
    const response = await request("post", `${team}/join-code`, true).send({});
    expect(response.status).toBe(503);
    expect(liveCodes().map(([path]) => path)).toEqual(["teamJoinCodes/OLDLIVE1"]);
    // Preserve the previous dead-code sweep and other-team isolation coverage.
    state.failPath = "";
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    state.docs.set("teamJoinCodes/OLDREV01", { teamId: team, revoked: true, revokedAt: old });
    state.docs.set("teamJoinCodes/OLDEXP01", { teamId: team, expiresAt: old });
    state.docs.set("teamJoinCodes/FRESHDEAD", { teamId: team, revoked: true, revokedAt: Date.now() });
    state.docs.set("teamJoinCodes/OTHERLIVE", { teamId: "other-team", revoked: false, expiresAt: Date.now() + 60_000 });
    expect((await request("post", `${team}/join-code`, true).send({})).status).toBe(201);
    expect(state.docs.has("teamJoinCodes/OLDREV01")).toBe(false);
    expect(state.docs.has("teamJoinCodes/OLDEXP01")).toBe(false);
    expect(state.docs.has("teamJoinCodes/FRESHDEAD")).toBe(true);
    expect(state.docs.get("teamJoinCodes/OTHERLIVE")?.revoked).toBe(false);
    expect(state.docs.get("teamJoinCodes/OLDLIVE1")?.revoked).toBe(true);
  });
  it("concurrent rotations from the same snapshot leave exactly one live code", async () => {
    state.docs.set("teamJoinCodes/OLDLIVE1", { code: "OLDLIVE1", teamId: team, revoked: false, expiresAt: Date.now() + 60_000 });
    const firstMint = deferred(); const secondScan = deferred(); let scans = 0;
    state.mintGate = async () => { firstMint.resolve(); await secondScan.promise; };
    state.collectionGate = async () => { if (++scans === 2) { await firstMint.promise; secondScan.resolve(); } };
    const responses = await Promise.all([request("post", `${team}/join-code`, true).send({}), request("post", `${team}/join-code`, true).send({})]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(liveCodes()).toHaveLength(1);
    state.collectionGate = null;
    // Sequential rotation must see the just-minted code, including through the real collection cache.
    expect((await request("post", `${team}/join-code`, true).send({})).status).toBe(201);
    expect(liveCodes()).toHaveLength(1);
  });
  it("failed leave retains the registry and valid membership; retry succeeds", async () => {
    ping(); state.failPath = `teamMembers/${member}`;
    expect((await request("post", "leave").send({})).status).toBe(503);
    expect(registry.listPositions().map((row) => row.memberId)).toContain(member);
    expect(state.docs.get(`teamMembers/${member}`)?.active).toBe(true);
    expect((await request("post", "heartbeat").send({ lat: 36.75, lng: 5.07 })).status).toBe(200);
    state.failPath = "";
    expect((await request("post", "leave").send({})).status).toBe(200);
    expect(registry.listPositions()).toHaveLength(0);
    expect(state.docs.get(`teamMembers/${member}`)?.active).toBe(false);
  });
  for (const replacement of ["different SOS", "same SOS new generation"]) for (const evidence of [true, false]) it(`delayed ${evidence ? "GPS" : "manual"} arrival cannot update replacement mission (${replacement})`, async () => {
    const path = `teamMissions/${team}`;
    state.docs.set(path, { sosId: "sos-A", phase: "en_route", since: 100, sosLat: 36.75, sosLng: 5.07 });
    const readStarted = deferred(); const resume = deferred();
    state.missionGate = async () => { readStarted.resolve(); await resume.promise; };
    const payload = evidence ? { phase: "on_scene", lat: 36.75, lng: 5.07, accuracy: 8 } : { phase: "on_scene" };
    const pending = request("post", "mission/phase").send(payload).then((response) => response);
    await readStarted.promise;
    // Exercise both a different SOS and a new dispatch generation of the same SOS.
    state.docs.set(path, { sosId: replacement === "different SOS" ? "sos-B" : "sos-A", phase: "en_route", since: 200, sosLat: 36.75, sosLng: 5.07 });
    resume.resolve();
    const response = await pending;
    expect(response.status).toBe(409); expect(response.body.code).toBe("MISSION_CHANGED");
    expect(state.docs.get(path)).toMatchObject({ phase: "en_route", since: 200 });
    fs.invalidateDocCache("teamMissions", team);
    expect((await request("post", "mission/phase").send(payload)).status).toBe(200);
    expect(state.docs.get(path)?.phase).toBe("on_scene");
  });
  it("invalidates a cached mission conflict so an immediate retry uses the replacement", async () => {
    const path = `teamMissions/${team}`;
    state.docs.set(path, { sosId: "sos-A", phase: "en_route", since: 100, sosLat: 36.75, sosLng: 5.07 });
    expect(await fs.docGet("teamMissions", team)).toMatchObject({ sosId: "sos-A", since: 100 });
    // Another instance replaces the mission without invalidating this instance's cache.
    state.docs.set(path, { sosId: "sos-B", phase: "en_route", since: 200, sosLat: 36.75, sosLng: 5.07 });
    expect(await fs.docGet("teamMissions", team)).toMatchObject({ sosId: "sos-A", since: 100 });
    const payload = { phase: "on_scene", lat: 36.75, lng: 5.07, accuracy: 8 };
    const conflict = await request("post", "mission/phase").send(payload);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("MISSION_CHANGED");
    expect(state.docs.get(path)).toMatchObject({ sosId: "sos-B", phase: "en_route", since: 200 });
    // No manual invalidation, TTL wait, or further mission change before retry.
    const retry = await request("post", "mission/phase").send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body.mission).toMatchObject({ sosId: "sos-B", phase: "on_scene", since: 200 });
    expect(state.docs.get(path)).toMatchObject({ sosId: "sos-B", phase: "on_scene", since: 200 });
  });
  it("an in-flight registry snapshot cannot restore GPS after gpsPurged acknowledgment", async () => {
    ping();
    const staged = deferred(); const resume = deferred(); const done = deferred();
    state.gpsGate = async () => { staged.resolve(); await resume.promise; }; state.gpsDone = done.resolve;
    registry.snapshotIfDue(member, team);
    await staged.promise;
    const response = await request("delete", `${team}/members/${member}`, true);
    expect(response.status).toBe(200); expect(response.body.gpsPurged).toBe(true);
    expect(registry.listPositions()).toHaveLength(0);
    resume.resolve(); await done.promise;
    const stored = state.docs.get(`teamMembers/${member}`);
    expect(stored).toMatchObject({ active: false, tokenGen: 1 });
    for (const field of ["lastKnownLat", "lastKnownLng", "lastSeenAt"]) expect(stored).not.toHaveProperty(field);
    // A separate active member still snapshots normally via the real registry.
    member = `tm-${(++sequence).toString(16).padStart(16, "0")}`;
    state.docs.set(`teamMembers/${member}`, { teamId: team, active: true, tokenGen: 0 });
    ping(); const normal = deferred(); state.gpsDone = normal.resolve;
    registry.snapshotIfDue(member, team); await normal.promise;
    expect(state.docs.get(`teamMembers/${member}`)).toMatchObject({ lastKnownLat: 36.75, lastKnownLng: 5.07 });
  });
});
