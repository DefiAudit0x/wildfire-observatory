import express from "express";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  result: { status: "empty" as "empty" | "ok" | "error", reports: [] as any[] },
}));

vi.mock("../server/db.js", () => ({
  getReportsDbResult: vi.fn(async () => dbState.result),
  seedReportsToFirestore: vi.fn(async () => undefined),
  saveReportToFirestore: vi.fn(async () => "saved"),
  confirmReportInFirestore: vi.fn(async () => null),
}));

const { default: reportsRouter } = await import("../server/routes/reports.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/reports", reportsRouter);
  return app;
}

describe("reports database result semantics", () => {
  it("returns 503 instead of silently serving memory data when Firestore fails", async () => {
    dbState.result = { status: "error", reports: [] };
    const res = await supertest(createApp()).get("/api/reports");

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("unavailable");
  });

  it("returns 503 when the database report dataset fails coordinate/status validation", async () => {
    dbState.result = {
      status: "ok",
      reports: [{ id: "bad-report", lat: "not-a-number", lng: 7.6, severity: "medium", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1 }],
    };
    const res = await supertest(createApp()).get("/api/reports");

    expect(res.status).toBe(503);
  });

  it("resolves a retry from the durable report result by clientGeneratedId", async () => {
    const durable = {
      id: "rep-durable-1",
      clientGeneratedId: "cg-durable-0001",
      lat: 36.75,
      lng: 7.6,
      locationName: "غابة محفوظة",
      wilaya: "الجزائر - عنابة (Algérie - Annaba)",
      description: "بلاغ محفوظ لاختبار idempotency الدائم",
      severity: "medium",
      status: "pending",
      consensusCount: 1,
    };
    dbState.result = { status: "ok", reports: [durable] };

    const res = await supertest(createApp()).post("/api/reports").send({
      ...durable,
      clientGeneratedId: durable.clientGeneratedId,
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(durable.id);
    expect(res.body.clientGeneratedId).toBe(durable.clientGeneratedId);
  });
});
