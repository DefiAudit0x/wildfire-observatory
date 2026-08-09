import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import badgesRouter from "../server/routes/badges.js";

function createBadgesApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/badges", badgesRouter);
  return app;
}

const BADGE_BODY = {
  code: "TEST-CODE",
  ownerName: "مختبر",
  type: "volunteer",
  wilaya: "الجزائر - الجزائر",
};

describe("Badge mutations require a valid admin session token", () => {
  it("rejects POST /api/badges without a token", async () => {
    const res = await supertest(createBadgesApp()).post("/api/badges").send(BADGE_BODY);
    expect(res.status).toBe(401);
  });

  it("rejects PUT /api/badges/:code without a token", async () => {
    const res = await supertest(createBadgesApp()).put("/api/badges/TEST-CODE").send({ ownerName: "محدث" });
    expect(res.status).toBe(401);
  });

  it("rejects DELETE /api/badges/:code without a token", async () => {
    const res = await supertest(createBadgesApp()).delete("/api/badges/TEST-CODE");
    expect(res.status).toBe(401);
  });

  it("rejects POST /api/badges/:code/toggle without a token", async () => {
    const res = await supertest(createBadgesApp()).post("/api/badges/TEST-CODE/toggle");
    expect(res.status).toBe(401);
  });

  it("does NOT accept the admin password in the request body", async () => {
    const res = await supertest(createBadgesApp()).post("/api/badges").send({
      ...BADGE_BODY,
      password: "some-admin-password",
    });
    expect(res.status).toBe(401);
  });
});