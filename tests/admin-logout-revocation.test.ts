/**
 * Fix 41 (ADM-5): admin logout must not acknowledge success when the
 * revocation write did not persist — the mirror of staff logout
 * (server/routes/auth.ts), which already returns 503 in that case.
 * Mounts the real adminRouter; the logout path itself only touches
 * middleware → fs.docSet, the rest are import-time dependencies.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const state = vi.hoisted(() => ({
  docSet: vi.fn(async () => true),
}));

vi.mock("../server/firebase.js", () => ({
  getDb: () => null,
  isAdminDb: () => false,
}));

vi.mock("../server/fs.js", () => ({
  docGet: vi.fn(async () => null),
  docSet: state.docSet,
  collectionGet: vi.fn(async () => null),
}));

vi.mock("../server/db.js", () => ({
  updateReportInFirestore: vi.fn(),
  deleteReportFromFirestore: vi.fn(),
  purgeReportWithIdempotency: vi.fn(),
  getReportsFromFirestore: vi.fn(),
  getReportPrivate: vi.fn(),
}));

vi.mock("../server/live.js", () => ({
  liveHub: { broadcast: vi.fn() },
}));

vi.mock("../server/email.js", () => ({
  sendFireAlert: vi.fn(),
}));

vi.mock("../server/routes/notifications.js", () => ({
  createNotification: vi.fn(),
}));

import adminRouter from "../server/routes/admin.js";
import { generateAdminToken } from "../server/middleware.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

beforeEach(() => {
  state.docSet.mockClear();
  state.docSet.mockResolvedValue(true);
});

describe("Fix 41 (ADM-5): admin logout revocation persistence", () => {
  it("returns 503 when the revocation write does not persist", async () => {
    state.docSet.mockResolvedValue(false); // durable write failed
    const res = await supertest(createApp())
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Session revocation could not be persisted" });
  });

  it("returns 200 when the revocation persists (control)", async () => {
    const res = await supertest(createApp())
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("returns 200 with no token — nothing to revoke (control)", async () => {
    const res = await supertest(createApp()).post("/api/admin/logout");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(state.docSet).not.toHaveBeenCalled();
  });

  it("a failed logout keeps the cookie, and a retry after recovery succeeds (Fix 41b)", async () => {
    // The token is httpOnly — the client holds no other copy. If the 503
    // cleared the cookie, the retry would send no token and succeed (200)
    // without ever re-attempting the durable write.
    const token = generateAdminToken("admin");
    state.docSet.mockResolvedValue(false); // durable write failed
    const failed = await supertest(createApp())
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(failed.status).toBe(503);
    expect(failed.headers["set-cookie"]).toBeUndefined();

    state.docSet.mockResolvedValue(true); // the write recovers
    const retried = await supertest(createApp())
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ success: true });
    expect(retried.headers["set-cookie"]?.[0]).toContain("admin_token=;");
  });
});
