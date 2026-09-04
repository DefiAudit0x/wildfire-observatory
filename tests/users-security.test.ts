/**
 * v2.6.0 — S-M2 role-matrix unification:
 *   The password-admin ("admin") used to be able to DELETE staff accounts
 *   (DELETE required "superadmin","admin") while being unable to even LIST
 *   them (GET/POST/PUT required "superadmin","commander"). The matrix is now
 *   uniform: {admin, superadmin} = global staff management, commander = own
 *   unit's agents only, agent = nothing. S-M8: user create/update/delete now
 *   land in the audit trail.
 */
import express from "express";
import supertest from "supertest";
import { describe, expect, it, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  collectionGet: vi.fn(),
  docGet: vi.fn(),
  docUpdate: vi.fn(async () => true),
  docDelete: vi.fn(async () => true),
  createUserIfUnitExists: vi.fn(async () => "created"),
  logAdminAction: vi.fn(async () => undefined),
}));

vi.mock("../server/fs.js", () => ({
  collectionGet: state.collectionGet,
  docGet: state.docGet,
  docUpdate: state.docUpdate,
  docDelete: state.docDelete,
  docSet: vi.fn(async () => true),
}));

vi.mock("../server/atomic.js", () => ({
  createUserIfUnitExists: state.createUserIfUnitExists,
  createDocIfAbsent: vi.fn(),
}));

vi.mock("../server/routes/audit.js", () => ({
  logAdminAction: state.logAdminAction,
  actorFromRequest: (req: any) => ({ agentId: req.admin?.agentId ?? null, name: null, ip: null }),
}));

import usersRouter from "../server/routes/users.js";
import { generateStaffToken, generateAdminToken } from "../server/middleware.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/users", usersRouter);
  return app;
}

const UNIT_USER = { agentId: "agent-1", name: "Agent One", role: "agent", unitId: "unit-dz16", isActive: true };

beforeEach(() => {
  state.collectionGet.mockReset().mockResolvedValue([UNIT_USER]);
  state.docGet.mockReset().mockResolvedValue(UNIT_USER);
  state.docUpdate.mockClear();
  state.docDelete.mockClear();
  state.createUserIfUnitExists.mockClear();
  state.logAdminAction.mockClear();
});

describe("users commander unit scope (pre-existing behaviour, kept)", () => {
  it("rejects a commander token without an assigned unit before listing users", async () => {
    const token = generateStaffToken({ role: "commander", agentId: "commander-without-unit" });
    const res = await supertest(createApp())
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("no assigned unit");
  });

  it("rejects an agent everywhere on the users surface", async () => {
    const token = generateStaffToken({ role: "agent", agentId: "agent-1", unitId: "unit-dz16" });
    const app = createApp();
    expect((await supertest(app).get("/api/users").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await supertest(app).post("/api/users").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await supertest(app).put("/api/users/x").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await supertest(app).delete("/api/users/x").set("Authorization", `Bearer ${token}`)).status).toBe(403);
  });
});

describe("S-M2: password-admin now has a UNIFORM staff-management surface", () => {
  it("admin CAN list users (was 403 while delete was 200 — the S-M2 contradiction)", async () => {
    const res = await supertest(createApp())
      .get("/api/users")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
  });

  it("admin CAN create a staff account in any unit", async () => {
    const res = await supertest(createApp())
      .post("/api/users")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`)
      .send({ agentId: "new-agent", name: "New Agent", role: "agent", unitId: "unit-dz16", password: "Str0ngPassw0rd" });
    expect(res.status).toBe(201);
  });

  it("admin CAN update a staff account (role change included)", async () => {
    const res = await supertest(createApp())
      .put("/api/users/agent-1")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`)
      .send({ role: "commander" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("commander");
  });

  it("admin CAN still delete (behaviour kept — but now consistent with view)", async () => {
    const res = await supertest(createApp())
      .delete("/api/users/agent-1")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`);
    expect(res.status).toBe(200);
  });

  it("superadmin keeps the full surface", async () => {
    const token = generateAdminToken("superadmin");
    expect((await supertest(createApp()).get("/api/users").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await supertest(createApp()).delete("/api/users/agent-1").set("Authorization", `Bearer ${token}`)).status).toBe(200);
  });
});

describe("S-M8: privilege shifts land in the audit trail", () => {
  it("user.create is audited", async () => {
    await supertest(createApp())
      .post("/api/users")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`)
      .send({ agentId: "new-agent", name: "New Agent", role: "agent", unitId: "unit-dz16", password: "Str0ngPassw0rd" });
    expect(state.logAdminAction).toHaveBeenCalledWith(
      "user.create",
      expect.objectContaining({ targetAgentId: "new-agent", role: "agent" }),
      expect.anything()
    );
  });

  it("user.update is audited with the role transition, never the password", async () => {
    await supertest(createApp())
      .put("/api/users/agent-1")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`)
      .send({ role: "commander", password: "Str0ngPassw0rd" });
    expect(state.logAdminAction).toHaveBeenCalledWith(
      "user.update",
      expect.objectContaining({
        targetAgentId: "agent-1",
        roleChange: { from: "agent", to: "commander" },
      }),
      expect.anything()
    );
    const details = (state.logAdminAction.mock.calls[0] as any[])[1];
    expect(JSON.stringify(details)).not.toContain("Str0ngPassw0rd");
  });

  it("user.delete is audited", async () => {
    await supertest(createApp())
      .delete("/api/users/agent-1")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`);
    expect(state.logAdminAction).toHaveBeenCalledWith(
      "user.delete",
      expect.objectContaining({ targetAgentId: "agent-1" }),
      expect.anything()
    );
  });
});

describe("v2.15.0 — superadmin grant separation (no admin→superadmin escalation)", () => {
  it("password-admin JWT CANNOT create a superadmin staff account", async () => {
    const token = generateAdminToken("admin");
    const res = await supertest(createApp())
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId: "new-super", name: "New Super", role: "superadmin", unitId: "unit-dz16", password: "Passw0rd123" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SUPERADMIN_GRANT_FORBIDDEN");
    expect(state.createUserIfUnitExists).not.toHaveBeenCalled();
  });

  it("true superadmin JWT CAN create a superadmin staff account", async () => {
    const token = generateAdminToken("superadmin");
    const res = await supertest(createApp())
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId: "new-super-2", name: "New Super 2", role: "superadmin", unitId: "unit-dz16", password: "Passw0rd123" });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("superadmin");
  });

  it("password-admin JWT CANNOT upgrade an existing account to superadmin, nor mutate/delete a superadmin doc", async () => {
    const token = generateAdminToken("admin");

    state.docGet.mockResolvedValue({ ...UNIT_USER, role: "agent" });
    const upgrade = await supertest(createApp())
      .put("/api/users/agent-1")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "superadmin" });
    expect(upgrade.status).toBe(403);
    expect(upgrade.body.code).toBe("SUPERADMIN_GRANT_FORBIDDEN");

    state.docGet.mockResolvedValue({ ...UNIT_USER, role: "superadmin" });
    const mutate = await supertest(createApp())
      .put("/api/users/agent-1")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed Super" });
    expect(mutate.status).toBe(403);
    expect(mutate.body.code).toBe("SUPERADMIN_GRANT_FORBIDDEN");

    const del = await supertest(createApp())
      .delete("/api/users/agent-1")
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(403);
    expect(del.body.code).toBe("SUPERADMIN_GRANT_FORBIDDEN");
    expect(state.docDelete).not.toHaveBeenCalled();
  });
});
