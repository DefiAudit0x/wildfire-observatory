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
  // v2.4.0 (S-H2): the route serves the pre-sanitized wire — the mock mirrors
  // the real gate (validate → sanitize) so the 503-on-invalid-dataset test
  // still exercises the route's honest-failure semantics.
  getPublicReportsWire: vi.fn(async () => {
    if (dbState.result.status !== "ok") return dbState.result;
    const clusterable = (r: any) =>
      Boolean(r) && typeof r.id === "string" && r.id.length > 0 &&
      Number.isFinite(r.lat) && r.lat >= -90 && r.lat <= 90 &&
      Number.isFinite(r.lng) && r.lng >= -180 && r.lng <= 180 &&
      typeof r.timestamp === "string" && !Number.isNaN(Date.parse(r.timestamp)) &&
      Number.isInteger(r.consensusCount) && r.consensusCount >= 0 &&
      ["low", "medium", "high", "critical"].includes(r.severity) &&
      ["pending", "verified", "rejected", "resolved"].includes(r.status);
    if (!dbState.result.reports.every(clusterable)) return { status: "error" as const };
    const sanitize = (report: any) => {
      if (!report) return report;
      const { reporterPhone: _rp, reporterName: _rn, reporterBadgeCode: _rbc, deviceId: _did, image: _img, ...safe } = report;
      if (safe.hasImage === undefined && typeof report.image === "string" && report.image.length > 0) safe.hasImage = true;
      return safe;
    };
    return { status: "ok" as const, reports: dbState.result.reports.map(sanitize) };
  }),
  getReportImageDataUrl: vi.fn(async () => null),
  getReportPrivate: vi.fn(async () => null),
  sanitizePublicReport: (report: any) => {
    if (!report) return report;
    const { reporterPhone: _rp, reporterName: _rn, reporterBadgeCode: _rbc, deviceId: _did, image: _img, ...safe } = report;
    if (safe.hasImage === undefined && typeof report.image === "string" && report.image.length > 0) safe.hasImage = true;
    return safe;
  },
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
    const { createPublicPrincipalToken, PUBLIC_PRINCIPAL_COOKIE } = await import(
      "../server/public-principal.js"
    );
    dbState.confirmation = { status: "error" };
    meshBroadcast.mockClear();

    // ARC-H1: the endpoint requires the server-issued public principal.
    // v2.3.0: no demo seed exists to mutate — the assertion is that the
    // failure surfaces as a 503 and nothing is broadcast as confirmed.
    const res = await supertest(createApp())
      .post("/api/reports/rep-1/confirm")
      .set("Cookie", `${PUBLIC_PRINCIPAL_COOKIE}=${createPublicPrincipalToken("subject-durable-test" as any)}`)
      .send({ deviceId: "consensus-failure-device" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CONSENSUS_DURABILITY_UNAVAILABLE");
    expect(meshBroadcast).not.toHaveBeenCalled();
    dbState.confirmation = { status: "no_db" };
  });

  it("answers 404 on no_db — without a database no reports exist, honestly (v2.3.0)", async () => {
    const { createPublicPrincipalToken, PUBLIC_PRINCIPAL_COOKIE } = await import(
      "../server/public-principal.js"
    );
    dbState.confirmation = { status: "no_db" };
    meshBroadcast.mockClear();

    // The old dev fallback confirmed votes against fabricated demo rows.
    // With the seed purged there is nothing to confirm against — the route
    // must NOT pretend a vote was recorded.
    const res = await supertest(createApp())
      .post("/api/reports/rep-1/confirm")
      .set("Cookie", `${PUBLIC_PRINCIPAL_COOKIE}=${createPublicPrincipalToken("subject-no-db-test" as any)}`)
      .send({ deviceId: "no-db-device" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
    expect(meshBroadcast).not.toHaveBeenCalled();
    dbState.confirmation = { status: "no_db" };
  });
});
