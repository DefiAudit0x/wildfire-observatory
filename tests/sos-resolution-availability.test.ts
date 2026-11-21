import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

type StoredDoc = Record<string, unknown>;
type Ref = { path: string };
type MissionQuery = { name: string; field: string; value: unknown };
const state = vi.hoisted(() => ({
  docs: new Map<string, StoredDoc>(),
  client: false,
  getDbError: undefined as Error | undefined,
  events: [] as string[],
  beforeDocRead: undefined as ((path: string) => void) | undefined,
  readReports: vi.fn<() => Promise<{ docs: { id: string; data: () => StoredDoc }[] }>>(),
}));

function docSnapshot(ref: Ref) {
  const data = state.docs.get(ref.path);
  return { ref, id: ref.path.split("/").at(-1), exists: Boolean(data), data: () => data };
}

function missionSnapshot(q: MissionQuery) {
  const docs = [...state.docs.entries()]
    .filter(([path, data]) => path.startsWith(`${q.name}/`) && data[q.field] === q.value)
    .map(([path, data]) => ({ ref: { path }, data: () => data }));
  return { docs, forEach: (cb: (snap: typeof docs[number]) => void) => docs.forEach(cb) };
}

async function transaction<T>(callback: (tx: {
  get: (ref: Ref | MissionQuery) => Promise<unknown>;
  set: (ref: Ref, data: StoredDoc) => void;
  update: (ref: Ref, data: StoredDoc) => void;
}) => Promise<T>): Promise<T> {
  state.events.push("transaction");
  const writes: { ref: Ref; data: StoredDoc; merge: boolean }[] = [];
  const result = await callback({
    get: async (ref) => {
      if (writes.length) throw new Error("Firestore transactions require all reads before writes");
      if (!("path" in ref)) {
        if (state.client) throw new Error("Client Transaction.get requires a DocumentReference");
        state.events.push("read missions");
        return missionSnapshot(ref);
      }
      state.events.push(`read ${ref.path}`);
      state.beforeDocRead?.(ref.path);
      const snap = docSnapshot(ref);
      return state.client ? { ...snap, exists: () => snap.exists } : snap;
    },
    set: (ref, data) => { writes.push({ ref, data, merge: false }); },
    update: (ref, data) => {
      state.events.push(`write ${ref.path}`);
      writes.push({ ref, data, merge: true });
    },
  });
  for (const { ref, data, merge } of writes) {
    state.docs.set(ref.path, { ...(merge ? state.docs.get(ref.path) : {}), ...data });
  }
  return result;
}

vi.mock("../server/firebase.js", () => ({
  isAdminDb: () => !state.client,
  getDb: () => {
    if (state.getDbError) throw state.getDbError;
    return {
      collection: (name: string) => {
        const reportsQuery = { limit: () => reportsQuery, get: () => state.readReports() };
        return {
          orderBy: () => reportsQuery,
          doc: (id: string) => ({ path: `${name}/${id}`, get: async () => docSnapshot({ path: `${name}/${id}` }) }),
          where: (field: string, _op: string, value: unknown) => ({ name, field, value }),
        };
      },
      runTransaction: transaction,
    };
  },
}));

vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, name: string) => ({ name }),
  doc: (_db: unknown, name: string, id: string) => ({ path: `${name}/${id}` }),
  where: (field: string, _op: string, value: unknown) => ({ field, value }),
  query: (col: { name: string }, filter: { field: string; value: unknown }) => ({ ...col, ...filter }),
  getDocs: async (q: MissionQuery) => {
    state.events.push("pre-read missions");
    return missionSnapshot(q);
  },
  runTransaction: (_db: unknown, callback: Parameters<typeof transaction>[0]) => transaction(callback),
}));

const { default: sosRouter } = await import("../server/routes/sos.js");
const { invalidateReportsCache } = await import("../server/db.js");
const { createSosWithAdmission, invalidateDocCache, resolveSosAtomically } = await import("../server/fs.js");
const { default: logger } = await import("../server/logger.js");
let sequence = 0;
function post(body: StoredDoc = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/sos", sosRouter);
  sequence += 1;
  return supertest(app).post("/api/sos")
    .set("X-Forwarded-For", `10.98.0.${sequence}`)
    .send({ deviceId: `fix13-device-${sequence}`, lat: 36.75, lng: 7.6, ...body })
    .timeout({ deadline: 4500 });
}

beforeEach(() => {
  state.docs.clear();
  state.events = [];
  state.client = false;
  state.getDbError = undefined;
  state.beforeDocRead = undefined;
  state.readReports.mockReset();
  invalidateReportsCache();
});
afterEach(() => { vi.restoreAllMocks(); });

function hangingReports() {
  state.readReports.mockImplementation(() => new Promise(() => {}));
}

describe("SOS-4 request-local proximity deadline (real route, DB and admission)", () => {
  it("admits a located SOS within the three-second context deadline when Firestore never settles", async () => {
    hangingReports();
    const warn = vi.spyOn(logger, "warn");
    const started = performance.now();
    const res = await post();
    expect(performance.now() - started).toBeLessThan(4000);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ priority: "unknown", nearbyFireCorroborated: false, nearestFireDistanceKm: null });
    expect(state.docs.get(`trappedSos/${res.body.id}`)?.status).toBe("active");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: "SOS proximity context timed out" }) }), expect.stringContaining("proceeding without context"));
  });

  it("applies context arriving in time and gives the next hanging read its own bounded deadline", async () => {
    state.readReports.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve({ docs: [{ id: "fire-fix13", data: () => ({ lat: 36.75, lng: 7.6, status: "active", timestamp: new Date().toISOString() }) }] }), 100);
    }));
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ priority: "critical", nearbyFireCorroborated: true, nearestFireDistanceKm: 0 });
    expect(state.docs.get(`trappedSos/${res.body.id}`)?.priority).toBe("critical");
    invalidateReportsCache();
    hangingReports();
    const next = await post();
    expect(next.status).toBe(200);
    expect(next.body.priority).toBe("unknown");
  });

  it("replays a durable idempotency key without starting the hanging context read", async () => {
    hangingReports();
    state.docs.set("sosIdempotency/fix13-replay", { sosId: "fix13-original" });
    state.docs.set("trappedSos/fix13-original", { id: "fix13-original", deviceId: "fix13-replay-device", status: "active" });
    const res = await post({ clientGeneratedId: "fix13-replay", deviceId: "fix13-replay-device" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "fix13-original", status: "active" });
    expect(state.readReports).not.toHaveBeenCalled();
    expect(state.events).not.toContain("transaction");
    expect(state.docs.size).toBe(2);
  });
});

describe.each([false, true])("FS-2 resolve SDK client=%s", (client) => {
  it("resolves and clears matching missions with every supported read before the writes", async () => {
    state.client = client;
    state.docs.set("trappedSos/fix13-resolve", { status: "active", dispatchedTeams: [{ teamId: "matching" }] });
    state.docs.set("teamMissions/matching", { sosId: "fix13-resolve", phase: "en_route" });
    state.docs.set("teamMissions/unrelated", { sosId: "other", phase: "on_scene" });
    expect(await resolveSosAtomically("fix13-resolve")).toEqual({ status: "resolved", missionsCleared: 1 });
    expect(state.docs.get("trappedSos/fix13-resolve")?.status).toBe("resolved");
    expect(state.docs.get("teamMissions/matching")?.phase).toBe("cleared");
    expect(state.docs.get("teamMissions/unrelated")?.phase).toBe("on_scene");
    expect(state.events).toEqual(client
      ? ["transaction", "read trappedSos/fix13-resolve", "read teamMissions/matching", "write trappedSos/fix13-resolve", "write teamMissions/matching"]
      : ["transaction", "read trappedSos/fix13-resolve", "read missions", "write trappedSos/fix13-resolve", "write teamMissions/matching"]);
  });
});

describe("Fix 13b client resolution", () => {
  const sosPath = "trappedSos/fix13b";
  const missionPath = "teamMissions/team";
  const dispatch = [{ teamId: "team" }];
  const activeMission = { sosId: "fix13b", phase: "en_route" };
  const reassignedMission = { sosId: "other", phase: "en_route" };

  function beforeSosRead(commit: () => void) {
    state.beforeDocRead = (path) => {
      if (path === sosPath) {
        state.beforeDocRead = undefined;
        commit();
      }
    };
  }

  beforeEach(() => {
    state.client = true;
    state.docs.set(sosPath, { status: "active" });
  });

  it("clears a dispatch committed just before the transactional SOS snapshot", async () => {
    // Both dispatch writes land after any out-of-transaction read and before
    // the transaction takes its SOS snapshot.
    beforeSosRead(() => {
      state.docs.set(sosPath, { status: "active", dispatchedTeams: dispatch });
      state.docs.set(missionPath, activeMission);
    });

    expect(await resolveSosAtomically("fix13b")).toEqual({ status: "resolved", missionsCleared: 1 });
    expect(state.docs.get(sosPath)?.status).toBe("resolved");
    expect(state.docs.get(missionPath)?.phase).toBe("cleared");
  });

  it("skips and does not count a mission reassigned before resolve reads it", async () => {
    state.docs.set(sosPath, { status: "active", dispatchedTeams: dispatch });
    state.docs.set(missionPath, activeMission);
    beforeSosRead(() => state.docs.set(missionPath, reassignedMission));

    const result = await resolveSosAtomically("fix13b");
    expect(state.docs.get(missionPath)).toEqual(reassignedMission);
    expect(result).toEqual({ status: "resolved", missionsCleared: 0 });
  });

  it("preserves a new live mission when resolving the old SOS again", async () => {
    state.docs.set(sosPath, { status: "active", dispatchedTeams: dispatch });
    state.docs.set(missionPath, activeMission);
    expect(await resolveSosAtomically("fix13b")).toEqual({ status: "resolved", missionsCleared: 1 });
    expect(state.docs.get(missionPath)?.phase).toBe("cleared");
    state.docs.set("trappedSos/other", { status: "active" });
    beforeSosRead(() => state.docs.set(missionPath, reassignedMission));

    const result = await resolveSosAtomically("fix13b");
    expect(state.docs.get(missionPath)).toEqual(reassignedMission);
    expect(result).toEqual({ status: "resolved", missionsCleared: 0 });
  });
});

describe("Fix 13c duplicate admission replay (real route and helpers)", () => {
  function gate<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  const duplicateBody = { error: "An SOS from this device was already received recently" };

  it("replays the first committed SOS after both early lookups miss, and retains no-key duplicate rejection", async () => {
    const firstContext = gate<{ docs: [] }>();
    const secondContext = gate<{ docs: [] }>();
    const firstStarted = gate<void>();
    const secondStarted = gate<void>();
    state.readReports
      .mockImplementationOnce(() => { firstStarted.resolve(); return firstContext.promise; })
      .mockImplementationOnce(() => { secondStarted.resolve(); return secondContext.promise; });
    const body = { deviceId: "fix13c-racing-device", clientGeneratedId: "fix13c-racing-key" };
    const first = post(body).then((res) => res);
    await firstStarted.promise;
    const second = post(body).then((res) => res);
    await secondStarted.promise;
    // Both requests passed their early replay lookup, but neither has admitted.
    expect(state.events).not.toContain("transaction");
    expect(state.docs.size).toBe(0);
    firstContext.resolve({ docs: [] });
    const original = await first;
    expect(original.status).toBe(200);
    expect(state.docs.get(`sosIdempotency/${body.clientGeneratedId}`)?.sosId).toBe(original.body.id);
    const info = vi.spyOn(logger, "info");
    secondContext.resolve({ docs: [] });
    const replay = await second;
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ id: original.body.id, status: original.body.status });
    expect(info).toHaveBeenCalledWith({ sosId: original.body.id }, "SOS replayed by clientGeneratedId");
    expect(state.events.filter((event) => event === "transaction")).toHaveLength(2);
    expect([...state.docs.keys()].filter((path) => path.startsWith("trappedSos/"))).toEqual([`trappedSos/${original.body.id}`]);

    const noKey = { deviceId: "fix13c-no-key-device", lat: null, lng: null };
    expect((await post(noKey)).status).toBe(200);
    const duplicate = await post(noKey);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual(duplicateBody);
  });

  it("rejects a different-device key found after duplicate admission with the replay ownership error", async () => {
    const deviceId = "fix13c-duplicate-owner";
    expect((await post({ deviceId, lat: null, lng: null })).status).toBe(200);
    // The early lookup sees a dangling ledger record; context then allows a
    // different device's SOS to commit before this request reaches admission.
    state.docs.set("sosIdempotency/fix13c-foreign-key", { sosId: "fix13c-foreign-sos" });
    state.readReports.mockImplementationOnce(async () => {
      expect(await createSosWithAdmission("fix13c-foreign-sos", {
        id: "fix13c-foreign-sos", deviceId: "fix13c-other-device", status: "active",
      }, "fix13c-other-admission", Date.now(), 300000)).toBe("created");
      return { docs: [] };
    });
    const res = await post({ deviceId, clientGeneratedId: "fix13c-foreign-key" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "SOS retry key belongs to a different device" });
    expect(state.readReports).toHaveBeenCalledTimes(1);
    expect(state.events.filter((event) => event === "transaction")).toHaveLength(3);
  });

  it("falls back to 409 when the duplicate-branch lookup throws or cannot resolve a stored SOS", async () => {
    const deviceId = "fix13c-lookup-failure-device";
    expect((await post({ deviceId, lat: null, lng: null })).status).toBe(200);
    // docGet's Firestore handle acquisition can throw, outside its read catch.
    // Trigger only after the real admission helper has obtained its handle.
    const failure = new Error("Firestore handle unavailable during replay");
    state.beforeDocRead = (path) => {
      if (path.startsWith("sosAdmissions/")) {
        invalidateDocCache("sosIdempotency", "fix13c-throwing-key");
        state.getDbError = failure;
      }
    };
    const error = vi.spyOn(logger, "error");
    const res = await post({ deviceId, clientGeneratedId: "fix13c-throwing-key", lat: null, lng: null });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(duplicateBody);
    expect(state.getDbError).toBe(failure);
    expect(state.events.filter((event) => event === "transaction")).toHaveLength(2);
    expect(error).toHaveBeenCalledWith({ err: failure }, "SOS idempotency lookup failed; returning duplicate");

    state.getDbError = undefined;
    state.beforeDocRead = undefined;
    const unresolvedDevice = "fix13c-unresolved-device";
    expect((await post({ deviceId: unresolvedDevice, lat: null, lng: null })).status).toBe(200);
    const unresolved = await post({ deviceId: unresolvedDevice, clientGeneratedId: "fix13c-unresolved-key", lat: null, lng: null });
    expect(unresolved.status).toBe(409);
    expect(unresolved.body).toEqual(duplicateBody);
    expect([...state.docs.keys()].filter((path) => path.startsWith("trappedSos/"))).toHaveLength(2);
  });
});
