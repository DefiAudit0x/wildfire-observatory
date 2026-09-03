import express from "express";
import cookieParser from "cookie-parser";
import supertest from "supertest";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ARC-H1 regression: the consensus endpoint used to be registered TWICE —
// inline in server.ts (public-principal contract) shadowing the reportsRouter
// route (legacy voter-cookie contract). Express matches the first handler, so
// the router machinery was production-dead while its tests stayed green. These
// tests now pin the SINGLE surviving contract: the reports router route keyed
// by the server-issued public principal and the durable confirmation ledger.

const ledgerState = vi.hoisted(() => ({
  result: { status: "confirmed", consensusCount: 2, statusValue: "pending" } as any,
  calls: [] as Array<{ reportId: string; subject: string }>,
}));
const meshBroadcast = vi.hoisted(() => vi.fn());
const principalState = vi.hoisted(() => ({
  subject: "subject-abc" as string | null,
}));

vi.mock("../server/mesh.js", () => ({
  meshHub: { broadcast: meshBroadcast },
}));

vi.mock("../server/public-principal.js", () => ({
  getPublicPrincipal: () =>
    principalState.subject
      ? { scope: "public-principal", subject: principalState.subject, jti: "jti-1" }
      : null,
}));

vi.mock("../server/confirmation-ledger.js", () => ({
  confirmReportWithPrincipal: vi.fn(async (reportId: string, subject: string) => {
    ledgerState.calls.push({ reportId, subject });
    return ledgerState.result;
  }),
}));

vi.mock("../server/db.js", () => ({
  getReportsDbResult: vi.fn(async () => ({ status: "no-db" })),
  seedReportsToFirestore: vi.fn(async () => undefined),
  saveReportWithIdempotency: vi.fn(async (report: any) => ({ status: "saved", report })),
  lookupReportIdempotency: vi.fn(async () => ({ status: "missing" })),
}));

const { default: reportsRouter } = await import("../server/routes/reports.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/reports", reportsRouter);
  return app;
}

beforeEach(() => {
  ledgerState.calls.length = 0;
  ledgerState.result = { status: "confirmed", consensusCount: 2, statusValue: "pending" };
  principalState.subject = "subject-abc";
  meshBroadcast.mockClear();
});

describe("ARC-H1: single principal-keyed consensus contract", () => {
  it("server.ts no longer registers a shadowing inline confirm route", () => {
    // Static guard: the shadowing was invisible to runtime tests because the
    // router was mounted directly. Keep it invisible in the source too.
    const serverSource = fs.readFileSync(
      path.join(process.cwd(), "server", "server.ts"),
      "utf8"
    );
    expect(serverSource).not.toMatch(/app\.post\(\s*["'`]\/api\/reports\/:id\/confirm/);
    // The endpoint must live in the reports router.
    const reportsSource = fs.readFileSync(
      path.join(process.cwd(), "server", "routes", "reports.ts"),
      "utf8"
    );
    expect(reportsSource).toMatch(/router\.post\("\/:id\/confirm"/);
  });

  it("requires a server-issued public principal (401 without one)", async () => {
    principalState.subject = null;
    const res = await supertest(createApp()).post("/api/reports/rep-1/confirm").send({});
    expect(res.status).toBe(401);
    expect(ledgerState.calls).toHaveLength(0);
  });

  it("confirms through the durable principal ledger and broadcasts", async () => {
    const res = await supertest(createApp()).post("/api/reports/rep-1/confirm").send({});
    expect(res.status).toBe(200);
    expect(ledgerState.calls[0]).toEqual({ reportId: "rep-1", subject: "subject-abc" });
    expect(res.body).toMatchObject({ success: true, consensusCount: 2, status: "pending" });
    expect(meshBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "report:confirm", id: "rep-1" })
    );
  });

  it("maps already_voted to 409 and not_found to 404", async () => {
    ledgerState.result = { status: "already_voted" };
    const voted = await supertest(createApp()).post("/api/reports/rep-1/confirm").send({});
    expect(voted.status).toBe(409);

    ledgerState.result = { status: "not_found" };
    const missing = await supertest(createApp()).post("/api/reports/rep-404/confirm").send({});
    expect(missing.status).toBe(404);
  });

  it("maps ledger errors to 503 CONSENSUS_DURABILITY_UNAVAILABLE", async () => {
    ledgerState.result = { status: "error" };
    const res = await supertest(createApp()).post("/api/reports/rep-1/confirm").send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CONSENSUS_DURABILITY_UNAVAILABLE");
  });
});

describe("ARC-M01/M02: bounded dev-only fallback ledger", () => {
  it("no_db in production is a 503, never a silent memory confirmation", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevSecret = process.env.JWT_SECRET;
    try {
      // Re-import the router with production config? config.nodeEnv is read at
      // import time; reload the module fresh with production env (config.ts
      // demands a strong JWT_SECRET in production — provide one).
      vi.resetModules();
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = "test-production-secret-strong-enough-123456";
      const { default: prodRouter } = await import("../server/routes/reports.js");
      const app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use("/api/reports", prodRouter);

      ledgerState.result = { status: "no_db" };
      const res = await supertest(app).post("/api/reports/rep-1/confirm").send({});
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("CONSENSUS_DURABILITY_UNAVAILABLE");
    } finally {
      if (prevSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevSecret;
      process.env.NODE_ENV = prevEnv || "test";
      vi.resetModules();
    }
  });

  it("dev/no_db answers 404 — the demo-seed confirmation path was purged (v2.3.0)", async () => {
    // The old dev fallback confirmed votes against fabricated citizenReports
    // seed rows (dedupe by principal subject). v2.3.0 removed the seed and the
    // fallback: without a durable ledger there are no reports to confirm —
    // the route must 404, never fabricate a confirmation.
    ledgerState.result = { status: "no_db" };
    const app = createApp();

    const first = await supertest(app)
      .post("/api/reports/rep-1/confirm")
      .send({ deviceId: "ignored" });
    expect(first.status).toBe(404);

    const second = await supertest(app)
      .post("/api/reports/rep-1/confirm")
      .send({ deviceId: "ignored" });
    expect(second.status).toBe(404);
  });
});
