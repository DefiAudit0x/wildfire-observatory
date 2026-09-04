import express from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import notificationsRouter from "../server/routes/notifications.js";

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
    const res = await supertest(createApp())
      .post("/api/notifications/unsubscribe")
      .send({ email: "citizen@example.com", token: "0".repeat(64) });

    expect(res.status).toBe(503);
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
      .post("/api/notifications/enroll")
      .send({ deviceId: DEVICE });
    expect(enroll.status).toBe(200);
    const cookie = enroll.headers["set-cookie"];
    expect(cookie).toBeDefined();

    const read = await supertest(app).get(`/api/notifications/${DEVICE}`).set("Cookie", cookie);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([]);
  });

  it("enroll validates the deviceId shape and rejects a mismatched existing binding", async () => {
    const app = createApp();
    const bad = await supertest(app).post("/api/notifications/enroll").send({ deviceId: "not-a-device-id" });
    expect(bad.status).toBe(400);

    const other = await supertest(app).post("/api/notifications/enroll").send({ deviceId: "web_ffffffffffffffff" });
    const cookie = other.headers["set-cookie"];
    const mismatch = await supertest(app)
      .post("/api/notifications/enroll")
      .set("Cookie", cookie)
      .send({ deviceId: DEVICE });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe("DEVICE_MISMATCH");
  });

  it("GET with a cookie bound to a DIFFERENT device stays a 403 IDOR refusal", async () => {
    const app = createApp();
    const other = await supertest(app).post("/api/notifications/enroll").send({ deviceId: "web_ffffffffffffffff" });
    const res = await supertest(app)
      .get(`/api/notifications/${DEVICE}`)
      .set("Cookie", other.headers["set-cookie"]);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DEVICE_MISMATCH");
  });
});
