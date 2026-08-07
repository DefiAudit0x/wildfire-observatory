import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import { generateStaffToken, generateAdminToken, requireAuth, requireRole } from "../server/middleware.js";
import authRouter from "../server/routes/auth.js";

function createAuthTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  return app;
}

describe("requireAuth", () => {
  it("rejects requests without a token", async () => {
    const app = express();
    app.get("/protected", requireAuth, (_req, res) => res.json({ ok: true }));
    const res = await supertest(app).get("/protected");
    expect(res.status).toBe(401);
  });

  it("accepts a valid staff token", async () => {
    const app = express();
    app.get("/protected", requireAuth, (req: any, res) => res.json({ role: req.admin.role }));
    const token = generateStaffToken({ role: "agent", unitId: "unit-dz16", agentId: "a1" });
    const res = await supertest(app).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("agent");
  });

  it("rejects a forged/invalid token", async () => {
    const app = express();
    app.get("/protected", requireAuth, (_req, res) => res.json({ ok: true }));
    const res = await supertest(app).get("/protected").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

describe("requireRole", () => {
  it("allows a commander on commander routes", async () => {
    const app = express();
    app.get("/staff", requireRole("superadmin", "commander"), (_req, res) => res.json({ ok: true }));
    const token = generateStaffToken({ role: "commander", unitId: "unit-dz16", agentId: "c1" });
    const res = await supertest(app).get("/staff").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("forbids an agent on commander routes", async () => {
    const app = express();
    app.get("/staff", requireRole("superadmin", "commander"), (_req, res) => res.json({ ok: true }));
    const token = generateStaffToken({ role: "agent", unitId: "unit-dz16", agentId: "a1" });
    const res = await supertest(app).get("/staff").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("forbids a commander on superadmin-only routes", async () => {
    const app = express();
    app.delete("/unit/:id", requireRole("superadmin"), (_req, res) => res.json({ ok: true }));
    const token = generateStaffToken({ role: "commander", unitId: "unit-dz16", agentId: "c1" });
    const res = await supertest(app).delete("/unit/x").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/auth/login", () => {
  it("returns 400 for missing fields", async () => {
    const app = createAuthTestApp();
    const res = await supertest(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
  });

  it("returns 401 for unknown agent (no DB in tests)", async () => {
    const app = createAuthTestApp();
    const res = await supertest(app).post("/api/auth/login").send({ agentId: "nobody", password: "whatever123" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
  });
});

describe("POST /api/auth/session", () => {
  it("returns 401 without a token", async () => {
    const app = createAuthTestApp();
    const res = await supertest(app).get("/api/auth/session");
    expect(res.status).toBe(401);
  });

  it("returns the caller identity with a valid token", async () => {
    const app = createAuthTestApp();
    const token = generateAdminToken();
    const res = await supertest(app).get("/api/auth/session").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.user.role).toBe("admin");
  });
});
