import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

type StoredDoc = Record<string, unknown>;
type Ref = { path: string };
type MissionQuery = { name: string; field: string; value: unknown };
const state = vi.hoisted(() => ({
  docs: new Map<string, StoredDoc>(),
  client: false,
  events: [] as string[],
  readReports: vi.fn<() => Promise<{ docs: { id: string; data: () => StoredDoc }[] }>>(),
}));

function docSnapshot(ref: Ref) {
  const data = state.docs.get(ref.path);
  return { id: ref.path.split("/").at(-1), exists: Boolean(data), data: () => data };
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
  getDb: () => ({
    collection: (name: string) => {
      const reportsQuery = { limit: () => reportsQuery, get: () => state.readReports() };
      return {
        orderBy: () => reportsQuery,
        doc: (id: string) => ({ path: `${name}/${id}`, get: async () => docSnapshot({ path: `${name}/${id}` }) }),
        where: (field: string, _op: string, value: unknown) => ({ name, field, value }),
      };
    },
    runTransaction: transaction,
  }),
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
const { resolveSosAtomically } = await import("../server/fs.js");
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

  it("replays a durable idempotency key within the deadline despite a hanging context read", async () => {
    hangingReports();
    state.docs.set("sosIdempotency/fix13-replay", { sosId: "fix13-original" });
    state.docs.set("trappedSos/fix13-original", { id: "fix13-original", deviceId: "fix13-replay-device", status: "active" });
    const res = await post({ clientGeneratedId: "fix13-replay", deviceId: "fix13-replay-device" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "fix13-original", status: "active" });
    expect(state.events).not.toContain("transaction");
    expect(state.docs.size).toBe(2);
  });
});

describe.each([false, true])("FS-2 resolve SDK client=%s", (client) => {
  it("resolves and clears matching missions with every supported read before the writes", async () => {
    state.client = client;
    state.docs.set("trappedSos/fix13-resolve", { status: "active" });
    state.docs.set("teamMissions/matching", { sosId: "fix13-resolve", phase: "en_route" });
    state.docs.set("teamMissions/unrelated", { sosId: "other", phase: "on_scene" });
    expect(await resolveSosAtomically("fix13-resolve")).toEqual({ status: "resolved", missionsCleared: 1 });
    expect(state.docs.get("trappedSos/fix13-resolve")?.status).toBe("resolved");
    expect(state.docs.get("teamMissions/matching")?.phase).toBe("cleared");
    expect(state.docs.get("teamMissions/unrelated")?.phase).toBe("on_scene");
    expect(state.events).toEqual(client
      ? ["pre-read missions", "transaction", "read trappedSos/fix13-resolve", "write trappedSos/fix13-resolve", "write teamMissions/matching"]
      : ["transaction", "read trappedSos/fix13-resolve", "read missions", "write trappedSos/fix13-resolve", "write teamMissions/matching"]);
  });
});
