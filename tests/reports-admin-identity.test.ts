import { describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import supertest from "supertest";

const state = vi.hoisted(() => ({
  getReportPrivate: vi.fn(async () => ({
    reporterName: "Amina Reporter",
    reporterPhone: "+213555010203",
    reporterBadgeCode: "private-badge",
    deviceId: "private-device",
  })),
}));

vi.mock("../server/db.js", () => ({
  getPublicReportsWire: vi.fn(async () => ({
    status: "ok",
    reports: [{ id: "report-1", locationName: "Test forest", status: "verified" }],
  })),
  getReportPrivate: state.getReportPrivate,
  getReportImageDataUrl: vi.fn(async () => null),
  saveReportWithIdempotency: vi.fn(),
  lookupReportIdempotency: vi.fn(),
  sanitizePublicReport: (report: Record<string, unknown>) => report,
}));

vi.mock("../server/firebase.js", () => ({
  getDb: () => null,
  isAdminDb: () => false,
}));

vi.mock("express-rate-limit", () => ({ default: () => (_req: unknown, _res: unknown, next: () => void) => next() }));

const { generateAdminToken, generateStaffToken } = await import("../server/middleware.js");
const { default: reportsRouter } = await import("../server/routes/reports.js");

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use("/api/reports", reportsRouter);
  return app;
}

describe("GET /api/reports/:id/identity", () => {
  it("returns reporter identity only to an admin and keeps the public list stripped", async () => {
    const app = createApp();

    const publicList = await supertest(app).get("/api/reports");
    expect(publicList.status).toBe(200);
    expect(publicList.body[0]).not.toHaveProperty("reporterName");
    expect(publicList.body[0]).not.toHaveProperty("reporterPhone");

    const unauthenticated = await supertest(app).get("/api/reports/report-1/identity");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).not.toHaveProperty("reporterName");
    expect(unauthenticated.body).not.toHaveProperty("reporterPhone");
    expect(state.getReportPrivate).not.toHaveBeenCalled();

    // Fix 4 made staff sessions fail closed when the revocation register
    // cannot be read: a token carrying agentId needs a live DB to revalidate
    // (requireAuth 401s under a null DB before the role gate is reached).
    // This test's 403 leg asserts the identity endpoint's role gate, so it
    // uses an agentId-less staff token, which reaches requireAdmin under a
    // null DB; the agentId staff path is covered by the middleware tests.
    const staff = await supertest(app)
      .get("/api/reports/report-1/identity")
      .set("Cookie", `staff_token=${generateStaffToken({ role: "agent" })}`);
    expect(staff.status).toBe(403);
    expect(staff.body).not.toHaveProperty("reporterName");
    expect(state.getReportPrivate).not.toHaveBeenCalled();

    const admin = await supertest(app)
      .get("/api/reports/report-1/identity")
      .set("Cookie", `admin_token=${generateAdminToken("admin")}`);
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ reporterName: "Amina Reporter", reporterPhone: "+213555010203" });
    expect(admin.headers["cache-control"]).toBe("no-store");
    expect(state.getReportPrivate).toHaveBeenCalledWith("report-1");

    const adminList = await supertest(app).get("/api/reports")
      .set("Cookie", `admin_token=${generateAdminToken("admin")}`);
    expect(adminList.body).toEqual(publicList.body);
  });
});
