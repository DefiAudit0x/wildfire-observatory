/**
 * Independent verification check for F053 (Fix 81), append path:
 * POST /:date appends via appendRosterPostAtomic (server/atomic.ts:282-287),
 * which the round-3 diff did NOT touch. A caller-supplied post id that
 * already exists in the day must be rejected; if the append returns
 * "created" and the day ends up with two posts sharing one id, F053 is
 * only partially fixed (PUT daySchema was fixed, the atomic append was not).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type StoredDoc = Record<string, unknown>;
const state = vi.hoisted(() => ({ docs: new Map<string, StoredDoc>(), queue: Promise.resolve() }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => createAdminDb(),
  isAdminDb: () => true,
}));

function snapshotFor(path: string) {
  const data = state.docs.get(path);
  return { exists: Boolean(data), id: path.split("/").at(-1), data: () => data };
}

function createAdminDb() {
  return {
    collection(collectionName: string) {
      return {
        doc(id: string) {
          const path = `${collectionName}/${id}`;
          return { id, path, get: async () => snapshotFor(path) };
        },
      };
    },
    async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      const previous = state.queue;
      let release!: () => void;
      state.queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const writes: Array<{ path: string; data: StoredDoc }> = [];
        const tx = {
          get: async (ref: { path: string }) => snapshotFor(ref.path),
          set: (ref: { path: string }, data: StoredDoc) => writes.push({ path: ref.path, data }),
          create: (ref: { path: string }, data: StoredDoc) => writes.push({ path: ref.path, data }),
          update: (ref: { path: string }, data: StoredDoc) => writes.push({ path: ref.path, data }),
        };
        const result = await callback(tx);
        for (const w of writes) state.docs.set(w.path, w.data);
        return result;
      } finally {
        release();
      }
    },
  };
}

const { appendRosterPostAtomic } = await import("../server/atomic.js");

const COLLECTION = "units/unit-dz16/rosterDays";
const DATE = "2026-11-28";

describe("F053 independent check: atomic roster append", () => {
  beforeEach(() => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set(`${COLLECTION}/${DATE}`, {
      unitId: "unit-dz16",
      date: DATE,
      posts: [{ id: "p1", labelAr: "منصب أول", status: "active", personnel: [] }],
      updatedAt: new Date().toISOString(),
    });
  });

  it("rejects a single-post append whose id already exists in the day", async () => {
    const result = await appendRosterPostAtomic(COLLECTION, DATE, "unit-dz16",
      { id: "p1", labelAr: "منصب مكرر", status: "active", personnel: [] }, 50);
    console.log("F053-APPEND result=", result);
    const day = state.docs.get(`${COLLECTION}/${DATE}`) as any;
    const dupCount = (day.posts as any[]).filter((p: any) => p.id === "p1").length;
    console.log("F053-APPEND posts with id p1=", dupCount);
    expect(result).not.toBe("created");
    expect(dupCount).toBe(1);
  });
});
