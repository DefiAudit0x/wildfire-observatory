import express from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import usersRouter from "../server/routes/users.js";
import { generateStaffToken } from "../server/middleware.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/users", usersRouter);
  return app;
}

describe("users commander unit scope", () => {
  it("rejects a commander token without an assigned unit before listing users", async () => {
    const token = generateStaffToken({ role: "commander", agentId: "commander-without-unit" });
    const res = await supertest(createApp())
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("no assigned unit");
  });
});
