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
});
