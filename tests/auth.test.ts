import { describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { generateStaffToken, generateAdminToken, requireAuth, requireRole, isCurrentStaffSession } from "../server/middleware.js";
import { createMeshToken } from "../server/mesh-auth.js";
import authRouter from "../server/routes/auth.js";

vi.mock("../server/firebase.js", () => ({ getDb: () => ({}) }));
vi.mock("../server/fs.js", () => ({
  docGet: async (collection: string, id: string) => collection === "users" && ["a1", "c1"].includes(id)
    ? { agentId: id, role: id === "c1" ? "commander" : "agent", unitId: "unit-dz16", isActive: true, passwordHash: "$2b$10$e1bkpv84TIYiq0ggHhiisOK6ntqHcJ6M21faN1ovhADmWc7TVzjNy" }
    : null,
}));
vi.mock("../server/routes/audit.js", () => ({ logAdminAction: vi.fn(async () => {}) }));

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

  it("rejects a mesh-scope token as a session credential (C2)", async () => {
    const app = express();
    app.get("/protected", requireAuth, (_req, res) => res.json({ ok: true }));
    const token = createMeshToken("attacker-device");
    const res = await supertest(app).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("mesh");
  });
});

describe("isCurrentStaffSession", () => {
  const token = { role: "agent" as const, unitId: "unit-dz16", agentId: "a1" };

  it("accepts an active user whose role and unit still match the token", () => {
    expect(isCurrentStaffSession(token, {
      agentId: "a1",
      role: "agent",
      unitId: "unit-dz16",
      isActive: true,
    })).toBe(true);
  });

  it("rejects a token after the account is deactivated", () => {
    expect(isCurrentStaffSession(token, {
      agentId: "a1",
      role: "agent",
      unitId: "unit-dz16",
      isActive: false,
    })).toBe(false);
  });

  it("rejects a token after the account role changes", () => {
    expect(isCurrentStaffSession(token, {
      agentId: "a1",
      role: "commander",
      unitId: "unit-dz16",
      isActive: true,
    })).toBe(false);
  });

  it("rejects a token after the account moves to another unit", () => {
    expect(isCurrentStaffSession(token, {
      agentId: "a1",
      role: "agent",
      unitId: "unit-dz17",
      isActive: true,
    })).toBe(false);
  });

  it("rejects a token whose staff account no longer exists", () => {
    expect(isCurrentStaffSession(token, null)).toBe(false);
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

  it("logs in a present user with the right password and sets the staff cookie", async () => {
    const app = createAuthTestApp();
    const res = await supertest(app).post("/api/auth/login").send({ agentId: "a1", password: "staff-pass-123" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.agentId).toBe("a1");
    expect(res.body.user.role).toBe("agent");
    expect(res.body.user.unitId).toBe("unit-dz16");
    // The session rides an HTTP-only cookie, 24 h — not a bearer body field.
    const rawCookie = res.headers["set-cookie"];
    const setCookie = Array.isArray(rawCookie) ? rawCookie.join(";") : (rawCookie ?? "");
    expect(setCookie).toContain("staff_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Max-Age=86400");
  });

  it("returns 401 for a present user with the wrong password", async () => {
    const app = createAuthTestApp();
    const res = await supertest(app).post("/api/auth/login").send({ agentId: "a1", password: "wrong-pass" });
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
