import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import cookieParser from "cookie-parser";
import notificationsRouter from "../server/routes/notifications.js";

const notifyDbState = vi.hoisted(() => ({
  dbPresent: false,
  subscribers: [{ unsubscribeToken: "u".repeat(64) }],
  deleteCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../server/firebase.js", () => ({
  getDb: () => (notifyDbState.dbPresent ? {
    collection: () => ({
      where: () => ({
        get: async () => ({ docs: notifyDbState.subscribers.map((s) => ({
          data: () => s,
          ref: { delete: async () => { notifyDbState.deleteCalls.push(s); } },
        })) }),
      }),
    }),
  } : null),
  isAdminDb: () => true,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  // Mirror server.ts: the device_sig binding lives in cookies, parsed by
  // cookie-parser exactly as the real deployment mounts it.
  app.use(cookieParser());
  app.use("/api/notifications", notificationsRouter);
  return app;
}

describe("notification unsubscribe contract", () => {
  beforeEach(() => {
    notifyDbState.dbPresent = false;
    notifyDbState.deleteCalls.length = 0;
  });

  it("rejects a one-click unsubscribe link without a token", async () => {
    const res = await supertest(createApp())
      .get("/api/notifications/unsubscribe")
      .query({ email: "citizen@example.com" });

    expect(res.status).toBe(400);
  });

  it("renders confirmation instead of mutating state on a valid-shaped GET link", async () => {
    const res = await supertest(createApp())
      .get("/api/notifications/unsubscribe")
      .query({ email: "citizen@example.com", token: "0".repeat(64) });

    expect(res.status).toBe(200);
    expect(res.text).toContain("method=\"post\"");
  });

  it("rejects an invalid unsubscribe token on the POST action", async () => {
    notifyDbState.dbPresent = true;
    const res = await supertest(createApp())
      .post("/api/notifications/unsubscribe")
      .send({ email: "citizen@example.com", token: "0".repeat(64) });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Invalid unsubscribe token");
    expect(notifyDbState.deleteCalls).toHaveLength(0);
  });

  it("unsubscribes with a matching token", async () => {
    notifyDbState.dbPresent = true;
    const res = await supertest(createApp())
      .post("/api/notifications/unsubscribe")
      .send({ email: "citizen@example.com", token: "u".repeat(64) });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(notifyDbState.deleteCalls).toHaveLength(1);
  });

  it("requires the token on the POST unsubscribe endpoint", async () => {
    const res = await supertest(createApp())
      .post("/api/notifications/unsubscribe")
      .send({ email: "citizen@example.com" });

    expect(res.status).toBe(400);
  });

  it("requires a valid verification token on POST", async () => {
    const res = await supertest(createApp())
      .post("/api/notifications/verify")
      .send({ email: "citizen@example.com" });

    expect(res.status).toBe(400);
  });
});

describe("notification subscribe contract (Fix 8b — canonical wilayas)", () => {
  it("rejects a subscription with a non-canonical wilaya", async () => {
    // "Annaba" is not a canonical region identifier: report creation stores
    // "الجزائر - عنابة (Algérie - Annaba)", so saving "Annaba" could never
    // match a report and the subscriber would silently receive nothing.
    const res = await supertest(createApp())
      .post("/api/notifications/subscribe")
      .send({ email: "citizen@example.com", wilayas: ["Annaba"], minSeverity: "high" });

    expect(res.status).toBe(400);
  });

  it("accepts a subscription with canonical wilaya labels", async () => {
    // Validation passes, so the request reaches the database layer — with no
    // database in this environment that answers 503, not 400.
    const res = await supertest(createApp())
      .post("/api/notifications/subscribe")
      .send({ email: "citizen@example.com", wilayas: ["الجزائر - عنابة (Algérie - Annaba)"], minSeverity: "high" });

    expect(res.status).toBe(503);
  });
});

describe("v2.15.0 — device enrollment contract (no implicit first-claim binding)", () => {
  const DEVICE = "web_0123456789abcdef";

  it("GET without any cookie: 401 DEVICE_ENROLLMENT_REQUIRED and NO binding issued", async () => {
    const res = await supertest(createApp()).get(`/api/notifications/${DEVICE}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("DEVICE_ENROLLMENT_REQUIRED");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("explicit POST /enroll binds the browser (signed cookie) and the bound GET reads", async () => {
    const app = createApp();
    const enroll = await supertest(app)
      .post("/api/notifications/enroll").set("Sec-Fetch-Site", "same-origin")
      .send({ deviceId: DEVICE });
    expect(enroll.status).toBe(200);
    expect(enroll.body.deviceId).not.toBe(DEVICE);
    const cookie = enroll.headers["set-cookie"];
    expect(cookie).toBeDefined();

    const read = await supertest(app).get(`/api/notifications/${enroll.body.deviceId}`).set("Cookie", cookie);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([]);
  });

  it("enroll validates the deviceId shape and rejects a mismatched existing binding", async () => {
    const app = createApp();
    const bad = await supertest(app).post("/api/notifications/enroll").set("Sec-Fetch-Site", "same-origin").send({ deviceId: "not-a-device-id" });
    expect(bad.status).toBe(400);

    const other = await supertest(app).post("/api/notifications/enroll").set("Sec-Fetch-Site", "same-origin").send({ deviceId: "web_ffffffffffffffff" });
    const cookie = other.headers["set-cookie"];
    const mismatch = await supertest(app)
      .post("/api/notifications/enroll").set("Sec-Fetch-Site", "same-origin")
      .set("Cookie", cookie)
      .send({ deviceId: DEVICE });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe("DEVICE_MISMATCH");
  });

  it("GET with a cookie bound to a DIFFERENT device stays a 403 IDOR refusal", async () => {
    const app = createApp();
    const other = await supertest(app).post("/api/notifications/enroll").set("Sec-Fetch-Site", "same-origin").send({ deviceId: "web_ffffffffffffffff" });
    const res = await supertest(app)
      .get(`/api/notifications/${DEVICE}`)
      .set("Cookie", other.headers["set-cookie"]);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DEVICE_MISMATCH");
  });

  it("does not enroll a fresh browser for a caller-chosen victim device id", async () => {
    const app = createApp();
    const enroll = await supertest(app)
      .post("/api/notifications/enroll").set("Sec-Fetch-Site", "same-origin")
      .send({ deviceId: DEVICE });

    expect(enroll.status).toBe(200);
    expect(enroll.body.deviceId).not.toBe(DEVICE);
    const victimRead = await supertest(app)
      .get(`/api/notifications/${DEVICE}`)
      .set("Cookie", enroll.headers["set-cookie"]);
    expect(victimRead.status).toBe(403);
  });
  it("does not issue an enrollment cookie for a cross-site request", async () => {
    const response = await supertest(createApp())
      .post("/api/notifications/enroll")
      .set("Sec-Fetch-Site", "cross-site")
      .send({ deviceId: DEVICE });
    expect(response.status).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

});
