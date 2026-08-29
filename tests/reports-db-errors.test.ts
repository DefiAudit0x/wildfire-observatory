import express from "express";
import cookieParser from "cookie-parser";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  result: { status: "empty" as "empty" | "ok" | "error", reports: [] as any[] },
  confirmation: { status: "no_db" as "no_db" | "error" },
}));
const meshBroadcast = vi.hoisted(() => vi.fn());

vi.mock("../server/mesh.js", () => ({
  meshHub: { broadcast: meshBroadcast },
}));

vi.mock("../server/db.js", () => ({
  getReportsDbResult: vi.fn(async () => dbState.result),
  seedReportsToFirestore: vi.fn(async () => undefined),
  saveReportToFirestore: vi.fn(async () => "saved"),
  saveReportWithIdempotency: vi.fn(async (report: any) => report.clientGeneratedId === "cg-durable-0001"
    ? { status: "existing", report: { ...report, id: "rep-durable-1" } }
    : { status: "saved", report }),
  lookupReportIdempotency: vi.fn(async () => ({ status: "missing" })),
}));

// ARC-H1: the confirm route now speaks to the durable principal ledger, not
// confirmReportInFirestore — mock the module the route actually consumes.
vi.mock("../server/confirmation-ledger.js", () => ({
  confirmReportWithPrincipal: vi.fn(async () => dbState.confirmation as any),
}));

const { default: reportsRouter } = await import("../server/routes/reports.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser()); // ARC-H1: the principal contract reads cookies
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

  it("returns 503 without RAM mutation or broadcast when durable confirmation fails", async () => {
    const { citizenReports } = await import("../server/data.js");
    const { createPublicPrincipalToken, PUBLIC_PRINCIPAL_COOKIE } = await import(
      "../server/public-principal.js"
    );
    const seed = citizenReports.find((report) => report.id === "rep-1");
    if (!seed) throw new Error("expected rep-1 seed fixture");
    const before = seed.consensusCount;
    dbState.confirmation = { status: "error" };
    meshBroadcast.mockClear();

    // ARC-H1: the endpoint now requires the server-issued public principal.
    const res = await supertest(createApp())
      .post("/api/reports/rep-1/confirm")
      .set("Cookie", `${PUBLIC_PRINCIPAL_COOKIE}=${createPublicPrincipalToken("subject-durable-test" as any)}`)
      .send({ deviceId: "consensus-failure-device" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CONSENSUS_DURABILITY_UNAVAILABLE");
    expect(seed.consensusCount).toBe(before);
    expect(meshBroadcast).not.toHaveBeenCalled();
    dbState.confirmation = { status: "no_db" };
  });
});
