import express from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import notificationsRouter from "../server/routes/notifications.js";

function createApp() {
  const app = express();
  app.use(express.json());
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

  it("rejects a one-click unsubscribe link with an invalid token", async () => {
    const res = await supertest(createApp())
      .get("/api/notifications/unsubscribe")
      .query({ email: "citizen@example.com", token: "0".repeat(64) });

    expect(res.status).toBe(403);
  });

  it("requires the token on the POST unsubscribe endpoint", async () => {
    const res = await supertest(createApp())
      .post("/api/notifications/unsubscribe")
      .send({ email: "citizen@example.com" });

    expect(res.status).toBe(400);
  });
});
