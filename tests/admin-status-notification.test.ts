import { describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const mocks = vi.hoisted(() => ({
  updateReportInFirestore: vi.fn(async () => true),
  getReportsFromFirestore: vi.fn(async () => [
    {
      id: "firestore-only-report",
      deviceId: "device-123",
      locationName: "Forêt de test",
      status: "verified",
    },
  ]),
  deleteReportFromFirestore: vi.fn(async () => false),
  createNotification: vi.fn(async () => undefined),
  logAdminAction: vi.fn(async () => undefined),
  broadcast: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  updateReportInFirestore: mocks.updateReportInFirestore,
  getReportsFromFirestore: mocks.getReportsFromFirestore,
  deleteReportFromFirestore: mocks.deleteReportFromFirestore,
}));

vi.mock("../server/routes/notifications.js", () => ({
  createNotification: mocks.createNotification,
}));

vi.mock("../server/routes/audit.js", () => ({
  logAdminAction: mocks.logAdminAction,
}));

vi.mock("../server/live.js", () => ({
  liveHub: { broadcast: mocks.broadcast },
}));

vi.mock("../server/middleware.js", () => ({
  generateAdminToken: () => "test-admin-token",
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { default: adminRouter } = await import("../server/routes/admin.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

describe("POST /api/admin/reports/:id/update-status — notification source of truth", () => {
  it("uses the persisted Firestore report for notification metadata", async () => {
    const app = createApp();

    const res = await supertest(app)
      .post("/api/admin/reports/firestore-only-report/update-status")
      .send({ status: "verified" });

    expect(res.status).toBe(200);
    expect(mocks.updateReportInFirestore).toHaveBeenCalledWith(
      "firestore-only-report",
      { status: "verified" },
    );
    expect(mocks.getReportsFromFirestore).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: "device-123",
      bodyAr: expect.stringContaining("Forêt de test"),
    }));
  });

  it("does not manufacture notification identity from the update payload", async () => {
    mocks.createNotification.mockClear();
    mocks.getReportsFromFirestore.mockResolvedValueOnce([]);

    const app = createApp();
    const res = await supertest(app)
      .post("/api/admin/reports/unknown/update-status")
      .send({ status: "verified" });

    expect(res.status).toBe(200);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });
});
