/**
 * v2.6.0 — S-M8 audit durability:
 *   logAdminAction used to be fire-and-forget: a Firestore outage (or no-db
 *   mode) silently DROPPED every privileged action while the HTTP caller got
 *   200. A bounded pending queue now survives the outage, is retried on the
 *   next write and by a 60s sweeper, and GET /api/audit keeps serving the
 *   in-memory copy when the database read fails.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const state = vi.hoisted(() => ({
  docSetImpl: vi.fn(async () => true),
  docSetCalls: [] as Array<{ collection: string; id: string; data: any }>,
  collectionGet: vi.fn(),
}));

vi.mock("../server/fs.js", () => ({
  docSet: (...args: any[]) => {
    state.docSetCalls.push({ collection: args[0] as string, id: args[1] as string, data: args[2] });
    return state.docSetImpl(...(args as []));
  },
  collectionGet: state.collectionGet,
  docGet: vi.fn(async () => null),
}));

import auditRouter, { logAdminAction, flushPendingAudit } from "../server/routes/audit.js";
import { generateAdminToken } from "../server/middleware.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/audit", auditRouter);
  return app;
}

beforeEach(async () => {
  state.docSetImpl.mockClear();
  state.docSetImpl.mockResolvedValue(true);
  state.docSetCalls.length = 0;
  state.collectionGet.mockReset().mockResolvedValue(null);
  await flushPendingAudit(); // drain anything queued by earlier tests
});

describe("S-M8: durable audit queue", () => {
  it("persists an entry when the database is healthy", async () => {
    await logAdminAction("test.healthy", { ok: true }, { agentId: "a1", ip: "1.2.3.4" });
    expect(state.docSetImpl).toHaveBeenCalled();
    const call = state.docSetCalls[0];
    expect(call.collection).toBe("adminAuditLog");
    expect(call.data.action).toBe("test.healthy");
    expect(call.data.actorId).toBe("a1");
    expect(call.data.ip).toBe("1.2.3.4");
  });

  it("QUEUES the entry instead of dropping it when persistence fails (no-db)", async () => {
    state.docSetImpl.mockResolvedValue(false); // docSet's no-db contract
    await logAdminAction("test.outage", { n: 1 }, { ip: null });
    // Nothing hit the register, but the entry is queued, not lost:
    await flushPendingAudit();
    expect(state.docSetCalls.length).toBeGreaterThan(0);
  });

  it("replays queued entries on the NEXT successful write (outage recovery)", async () => {
    // Phase 1 — outage: two entries fail and queue.
    state.docSetImpl.mockResolvedValue(false);
    await logAdminAction("test.batch.a", {}, { ip: null });
    await logAdminAction("test.batch.b", {}, { ip: null });
    const failedCalls = state.docSetCalls.length;

    // Phase 2 — recovery: one more write flushes the backlog first.
    state.docSetImpl.mockResolvedValue(true);
    await logAdminAction("test.recovered", {}, { ip: null });

    const persistedActions = state.docSetCalls.slice(failedCalls).map((c) => c.data.action);
    expect(persistedActions).toEqual(
      expect.arrayContaining(["test.batch.a", "test.batch.b", "test.recovered"])
    );
    // The backlog is drained — flushing again writes nothing new.
    const after = state.docSetCalls.length;
    await flushPendingAudit();
    expect(state.docSetCalls.length).toBe(after);
  });

  it("AUD-2: concurrent drains persist A once and retain failed B for retry", async () => {
    state.docSetImpl.mockResolvedValue(false);
    await logAdminAction("race.A");
    await logAdminAction("race.B");
    state.docSetCalls.length = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.docSetImpl.mockImplementation(async () => {
      const action = state.docSetCalls.at(-1)?.data.action;
      if (action === "race.A") { await gate; return true; }
      return false;
    });
    const first = flushPendingAudit();
    const second = flushPendingAudit();
    release();
    await Promise.all([first, second]);
    const attempts = state.docSetCalls.map((call) => call.data.action);
    state.docSetCalls.length = 0;
    state.docSetImpl.mockResolvedValue(true);
    expect(await flushPendingAudit()).toBe(1);
    expect(state.docSetCalls.map((call) => call.data.action)).toEqual(["race.B"]);
    expect(attempts).toEqual(["race.A", "race.B"]);
    expect(await flushPendingAudit()).toBe(0);
  });

  it("AUD-2: a log joining a drain still persists its own new entry", async () => {
    state.docSetImpl.mockResolvedValue(false);
    await logAdminAction("joined.old");
    state.docSetCalls.length = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.docSetImpl.mockImplementation(async () => { await gate; return true; });
    const drain = flushPendingAudit();
    const log = logAdminAction("joined.new");
    release();
    await Promise.all([drain, log]);
    expect(state.docSetCalls.map((call) => call.data.action)).toEqual(["joined.old", "joined.new"]);
    expect(await flushPendingAudit()).toBe(0);
  });

  it("never throws — callers' .catch(() => {}) stay harmless", async () => {
    state.docSetImpl.mockRejectedValue(new Error("hard crash"));
    await expect(logAdminAction("test.hardcrash", {}, { ip: null })).resolves.toBeUndefined();
  });

  it("GET /api/audit serves the in-memory copy when the database read fails", async () => {
    state.collectionGet.mockRejectedValue(new Error("db down"));
    await logAdminAction("test.fallback", { marker: true }, { ip: null });
    const res = await supertest(createApp())
      .get("/api/audit")
      .set("Authorization", `Bearer ${generateAdminToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((e: any) => e.action === "test.fallback")).toBe(true);
  });

  it("GET /api/audit merges queued memory entries with durable rows (Fix 41 — AUD-3)", async () => {
    const oldRows = [1, 2].map((n) => ({
      id: `durable-${n}`,
      action: `test.durable-${n}`,
      timestamp: new Date(Date.now() - 3600_000 - n * 1000).toISOString(),
      actorId: "a1",
      ip: "1.2.3.4",
    }));
    state.collectionGet.mockResolvedValue(oldRows);
    state.docSetImpl.mockResolvedValue(false); // the next write queues
    await logAdminAction("test.queued-recent", { marker: true }, { ip: null });

    const res = await supertest(createApp())
      .get("/api/audit")
      .set("Authorization", `Bearer ${generateAdminToken()}`);
    expect(res.status).toBe(200);
    const actions = res.body.map((e: any) => e.action);
    expect(actions).toContain("test.durable-1");
    expect(actions).toContain("test.durable-2");
    expect(actions).toContain("test.queued-recent");
    // Newest first: the queued entry (logged just now) precedes the hour-old rows.
    expect(actions.indexOf("test.queued-recent")).toBeLessThan(actions.indexOf("test.durable-1"));
  });

  it("returns an entry that sits in both lists exactly once (Fix 41 — AUD-3)", async () => {
    // Log with a healthy write, then make the DB return that same entry.
    await logAdminAction("test.dedupe", { marker: true }, { ip: null });
    const logged = state.docSetCalls.find((c) => c.data.action === "test.dedupe");
    expect(logged).toBeDefined();
    state.collectionGet.mockResolvedValue([{ ...logged!.data }]);

    const res = await supertest(createApp())
      .get("/api/audit")
      .set("Authorization", `Bearer ${generateAdminToken()}`);
    expect(res.status).toBe(200);
    // The merged list must not double-count the entry. This test does NOT
    // discriminate the fix (old code returned the DB list alone, also once)
    // — it guards the merge against double-counting.
    expect(res.body.filter((e: any) => e.id === logged!.data.id)).toHaveLength(1);
  });

  it("caps the merged list at 100 entries, newest first (Fix 41 — AUD-3)", async () => {
    const durable = Array.from({ length: 100 }, (_, i) => ({
      id: `cap-durable-${i}`,
      action: `test.cap-durable-${i}`,
      timestamp: new Date(Date.now() - 3600_000 - i * 1000).toISOString(),
      actorId: "a1",
      ip: "1.2.3.4",
    }));
    state.collectionGet.mockResolvedValue(durable);
    state.docSetImpl.mockResolvedValue(false); // the next 5 writes queue
    for (let n = 0; n < 5; n++) {
      await logAdminAction(`test.cap-memory-${n}`, { marker: true }, { ip: null });
    }

    const res = await supertest(createApp())
      .get("/api/audit")
      .set("Authorization", `Bearer ${generateAdminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(100);
    const actions = res.body.map((e: any) => e.action);
    for (let n = 0; n < 5; n++) expect(actions).toContain(`test.cap-memory-${n}`);
  });
});
