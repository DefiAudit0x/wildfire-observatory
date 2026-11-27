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
  updateUserAtomic: vi.fn(),
  deleteUserAtomically: vi.fn(async () => "deleted"),
  removeAgentFromRosterDay: vi.fn(async () => true),
  appliedUpdates: [] as Array<{ agentId: string; update: any }>,
}));

vi.mock("../server/firebase.js", () => ({ getDb: () => ({}) }));

vi.mock("../server/fs.js", () => ({
  collectionGet: state.collectionGet,
  docGet: state.docGet,
  docUpdate: state.docUpdate,
  docDelete: state.docDelete,
  docSet: vi.fn(async () => true),
  updateUserAtomic: state.updateUserAtomic,
}));

vi.mock("../server/atomic.js", () => ({
  createUserIfUnitExists: state.createUserIfUnitExists,
  createDocIfAbsent: vi.fn(),
  deleteUserAtomically: state.deleteUserAtomically,
  removeAgentFromRosterDay: state.removeAgentFromRosterDay,
}));

vi.mock("../server/routes/audit.js", () => ({
  logAdminAction: state.logAdminAction,
  actorFromRequest: (req: any) => ({ agentId: req.admin?.agentId ?? null, name: null, ip: null }),
}));

// Fix 43b: the users route logs through server/logger.js — mock it so the
// incomplete-sweep warn is assertable (precedent: atomic-lifecycle.test.ts).
const loggerState = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));

vi.mock("../server/logger.js", () => ({ default: loggerState }));

import usersRouter from "../server/routes/users.js";
import * as fsMockModule from "../server/fs.js";
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
  state.docGet.mockReset().mockImplementation(async (collection: string, id: string) => {
    if (collection !== "users") return null;
    if (id === "commander-without-unit") return { agentId: id, role: "commander", isActive: true };
    return UNIT_USER;
  });
  state.docUpdate.mockClear();
  state.docDelete.mockClear();
  state.deleteUserAtomically.mockReset().mockResolvedValue("deleted");
  state.removeAgentFromRosterDay.mockReset().mockResolvedValue(true);
  state.createUserIfUnitExists.mockClear();
  state.logAdminAction.mockClear();
  loggerState.warn.mockClear();
  loggerState.error.mockClear();
  loggerState.info.mockClear();
  state.appliedUpdates.length = 0;
  // Fix 4d: the mock mirrors the real updateUserAtomic contract — it reads
  // the target fresh (via the mocked docGet) and runs the route's authorize
  // callback against that transaction-time snapshot, recording applied
  // updates so tests can prove no write landed on a forbidden outcome.
  state.updateUserAtomic.mockReset().mockImplementation(async (agentId: string, update: any, authorize: (t: any) => any) => {
    const target = await state.docGet("users", agentId, true);
    if (!target) return { outcome: "not-found" };
    const reason = authorize(target);
    if (reason) return { outcome: "forbidden", ...reason };
    state.appliedUpdates.push({ agentId, update });
    return { outcome: "updated", before: target, user: { ...target, ...update } };
  });
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
    expect(state.deleteUserAtomically).toHaveBeenCalledWith("agent-1", expect.any(Function));
    expect(state.docDelete).not.toHaveBeenCalled();
  });

  it("superadmin keeps the full surface", async () => {
    const token = generateAdminToken("superadmin");
    expect((await supertest(createApp()).get("/api/users").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await supertest(createApp()).delete("/api/users/agent-1").set("Authorization", `Bearer ${token}`)).status).toBe(200);
  });
});

describe("Fix 43 (USR-2): the roster-cleanup outcome is reported, not claimed", () => {
  const rosterDay = { id: "2026-11-25", posts: [{ personnel: [{ agentId: "agent-1" }] }] };
  const adminAuth = () => ({ Authorization: `Bearer ${generateAdminToken("admin")}` });

  it("reports a failed sweep in the response instead of logging a false success", async () => {
    state.collectionGet.mockResolvedValueOnce([rosterDay]);
    state.removeAgentFromRosterDay.mockResolvedValueOnce(false);
    const res = await supertest(createApp())
      .delete("/api/users/agent-1")
      .set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.rosterCleanup).toEqual({ days: 1, removed: 0, failed: 1 });
  });

  it("reports a successful sweep with the removed count", async () => {
    state.collectionGet.mockResolvedValueOnce([rosterDay]);
    state.removeAgentFromRosterDay.mockResolvedValueOnce(true);
    const res = await supertest(createApp())
      .delete("/api/users/agent-1")
      .set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.rosterCleanup).toEqual({ days: 1, removed: 1, failed: 0 });
  });

  it("Fix 43b: an unreadable roster is reported as an incomplete sweep, not an all-zero success", async () => {
    // collectionGet returns null on a read failure — the sweep never runs,
    // so the response must say so instead of reporting zeros that read as
    // "no affected days".
    state.collectionGet.mockResolvedValueOnce(null);
    const res = await supertest(createApp())
      .delete("/api/users/agent-1")
      .set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.rosterCleanup).toEqual({ days: 0, removed: 0, failed: 0, incomplete: true });
    expect(loggerState.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1" }),
      expect.stringContaining("incomplete")
    );
  });

  it("Fix 43c: a thrown roster sweep is reported as incomplete, not an all-zero success", async () => {
    // collectionGet THROWS (a docSet inside Promise.all throwing lands in
    // the same catch) — the catch used to log the failure but leave the
    // default all-zero rosterCleanup, which reads as "no affected days".
    state.collectionGet.mockRejectedValueOnce(new Error("roster read boom"));
    const res = await supertest(createApp())
      .delete("/api/users/agent-1")
      .set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.rosterCleanup).toEqual({ days: 0, removed: 0, failed: 0, incomplete: true });
    expect(loggerState.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1" }),
      expect.stringContaining("incomplete")
    );
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

    state.docGet.mockImplementation(async (collection: string) => collection === "users" ? { ...UNIT_USER, role: "agent" } : null);
    const upgrade = await supertest(createApp())
      .put("/api/users/agent-1")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "superadmin" });
    expect(upgrade.status).toBe(403);
    expect(upgrade.body.code).toBe("SUPERADMIN_GRANT_FORBIDDEN");

    state.docGet.mockImplementation(async (collection: string) => collection === "users" ? { ...UNIT_USER, role: "superadmin" } : null);
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

describe("Fix 4c: commander PUT re-checks the target fresh before the write", () => {
  const COMMANDER = { agentId: "commander-1", name: "Commander One", role: "commander", unitId: "unit-dz16", isActive: true };
  const AGENT = { agentId: "agent-1", name: "Agent One", role: "agent", unitId: "unit-dz16", isActive: true };

  it("rejects a password reset when the target was promoted after the first read", async () => {
    state.docGet.mockImplementation(async (collection: string, id: string, fresh?: boolean) => {
      if (collection !== "users") return null;
      if (id === "commander-1") return COMMANDER;
      if (id === "agent-1") return fresh ? { ...AGENT, role: "commander" } : AGENT;
      return null;
    });
    const token = generateStaffToken({ role: "commander", agentId: "commander-1", unitId: "unit-dz16" });
    const res = await supertest(createApp())
      .put("/api/users/agent-1")
      .set("Authorization", `Bearer ${token}`)
      .send({ password: "NewPassword123" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Commanders can only manage agent accounts");
    expect(state.updateUserAtomic).toHaveBeenCalled();
    expect(state.appliedUpdates).toHaveLength(0);
  });

  it("rejects an admin edit when the target was promoted to superadmin after the first read", async () => {
    state.docGet.mockImplementation(async (collection: string, id: string, fresh?: boolean) => {
      if (collection !== "users") return null;
      if (id === "agent-1") return fresh ? { ...AGENT, role: "superadmin" } : AGENT;
      return null;
    });
    const res = await supertest(createApp())
      .put("/api/users/agent-1")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`)
      .send({ name: "Renamed Agent" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only the superadmin credential can modify superadmin accounts");
    expect(state.updateUserAtomic).toHaveBeenCalled();
    expect(state.appliedUpdates).toHaveLength(0);
  });
});

describe("Fix 4d: commander PUT authorizes inside the update transaction", () => {
  const COMMANDER = { agentId: "commander-1", name: "Commander One", role: "commander", unitId: "unit-dz16", isActive: true };
  const AGENT = { agentId: "agent-1", name: "Agent One", role: "agent", unitId: "unit-dz16", isActive: true };

  it("a valid commander password reset still succeeds through the transaction", async () => {
    state.docGet.mockImplementation(async (collection: string, id: string) => {
      if (collection !== "users") return null;
      if (id === "commander-1") return COMMANDER;
      if (id === "agent-1") return AGENT;
      return null;
    });
    const token = generateStaffToken({ role: "commander", agentId: "commander-1", unitId: "unit-dz16" });
    const res = await supertest(createApp())
      .put("/api/users/agent-1")
      .set("Authorization", `Bearer ${token}`)
      .send({ password: "NewPassword123" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("agent");
    expect(state.updateUserAtomic).toHaveBeenCalled();
    expect(state.appliedUpdates).toHaveLength(1);
    expect(state.appliedUpdates[0].update.passwordHash).toBeDefined();
    expect(state.appliedUpdates[0].update.sessionVersion).toBeDefined();
  });

  it("rejects a move when the target changed unit inside the transaction", async () => {
    state.docGet.mockImplementation(async (collection: string, id: string, fresh?: boolean) => {
      if (collection !== "users") return null;
      if (id === "commander-1") return COMMANDER;
      if (id === "agent-1") return fresh ? { ...AGENT, unitId: "unit-other" } : AGENT;
      return null;
    });
    const token = generateStaffToken({ role: "commander", agentId: "commander-1", unitId: "unit-dz16" });
    const res = await supertest(createApp())
      .put("/api/users/agent-1")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed Agent" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Commanders can only manage their own unit's staff");
    expect(state.updateUserAtomic).toHaveBeenCalled();
    expect(state.appliedUpdates).toHaveLength(0);
  });
});
