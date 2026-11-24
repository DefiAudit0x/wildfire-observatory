import express from "express";
import cookieParser from "cookie-parser";
import supertest from "supertest";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  revocations: new Map<string, Record<string, unknown>>(),
  dbPresent: true,
  readNull: false,
  revocationReadFails: false,
  writeOk: true,
  docUpdate: vi.fn(),
}));
vi.mock("../server/firebase.js", () => ({ getDb: () => state.dbPresent ? {} : null }));
vi.mock("../server/fs.js", () => ({
  // Fix 4c: the mock mirrors the real docGet strict option — a strict
  // revocation read throws when revocationReadFails is set, so the
  // fail-closed path can be exercised without touching the users read.
  docGet: async (collection: string, id: string, _fresh?: boolean, opts?: { strict?: boolean }) => {
    if (collection === "adminRevocations" && opts?.strict && state.revocationReadFails) throw new Error("revocation register read failed");
    return collection === "users" ? state.users.get(id) : state.readNull ? null : state.revocations.get(id);
  },
  docSet: async (_collection: string, id: string, data: Record<string, unknown>) => {
    if (!state.writeOk) return false;
    state.revocations.set(id, data); return true;
  },
  docUpdate: state.docUpdate,
  // Fix 4d: the mock mirrors the real updateUserAtomic contract — it reads
  // the target from the in-memory users map and runs the route's authorize
  // callback against that transaction-time snapshot before applying the
  // update, so the guard sees a promotion that landed after the first read.
  updateUserAtomic: async (agentId: string, update: Record<string, unknown>, authorize: (t: any) => any) => {
    const target = state.users.get(agentId);
    if (!target) return { outcome: "not-found" };
    const reason = authorize(target);
    if (reason) return { outcome: "forbidden", ...reason };
    const user = { ...target, ...update };
    state.users.set(agentId, user);
    return { outcome: "updated", before: target, user };
  },
  collectionGet: vi.fn(async () => []),
  docDelete: vi.fn(),
}));
vi.mock("../server/routes/audit.js", () => ({ logAdminAction: vi.fn(async () => {}), actorFromRequest: vi.fn(() => ({})) }));
import authRouter from "../server/routes/auth.js";
import usersRouter from "../server/routes/users.js";
import { generateAdminToken, generateStaffToken, revokeAdminSession } from "../server/middleware.js";

function app() {
  const result = express(); result.use(express.json(), cookieParser());
  result.use("/auth", authRouter); result.use("/users", usersRouter); return result;
}
const password = "OriginalPass123";
beforeEach(async () => {
  state.users.clear(); state.revocations.clear(); state.dbPresent = true; state.readNull = false; state.revocationReadFails = false; state.writeOk = true;
  state.users.set("agent-1", { agentId: "agent-1", role: "agent", unitId: "DZ16", name: "Agent One", isActive: true, passwordHash: await bcrypt.hash(password, 4) });
  state.docUpdate.mockReset().mockImplementation(async (_collection: string, id: string, update: Record<string, unknown>) => {
    state.users.set(id, { ...state.users.get(id), ...update }); return true;
  });
});
async function login(application: ReturnType<typeof app>, pass = password) {
  const response = await supertest(application).post("/auth/login").send({ agentId: "agent-1", password: pass });
  expect(response.status).toBe(200);
  return (response.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
}
function session(application: ReturnType<typeof app>, cookie: string) {
  return supertest(application).get("/auth/session").set("Cookie", cookie);
}
describe("SAUTH-1 staff session lifecycle", () => {
  it("rejects a copied cookie after logout and permits a fresh login", async () => {
    const application = app(); const copied = await login(application);
    expect((await session(application, copied)).status).toBe(200);
    expect((await supertest(application).post("/auth/logout").set("Cookie", copied)).status).toBe(200);
    expect((await session(application, copied)).status).toBe(401);
    expect((await session(application, await login(application))).status).toBe(200);
  });
  it("invalidates every outstanding staff token on password reset and permits the new password", async () => {
    const application = app(); const first = await login(application); const second = await login(application);
    const reset = await supertest(application).put("/users/agent-1").set("Authorization", `Bearer ${generateAdminToken("superadmin")}`).send({ password: "ReplacementPass123" });
    expect(reset.status).toBe(200);
    expect((await session(application, first)).status).toBe(401);
    expect((await session(application, second)).status).toBe(401);
    expect((await session(application, await login(application, "ReplacementPass123"))).status).toBe(200);
  });
  it("reports failed durable logout and retains the local revocation during an outage", async () => {
    const application = app(); const copied = await login(application); state.writeOk = false;
    expect((await supertest(application).post("/auth/logout").set("Cookie", copied)).status).toBe(503);
    state.readNull = true;
    expect((await session(application, copied)).status).toBe(401);
  });
  it("fails closed for staff when the database disappears", async () => {
    const application = app(); const copied = await login(application); state.dbPresent = false;
    expect((await session(application, copied)).status).toBe(401);
  });
  it("fails closed for staff when the revocation register read fails (Fix 4c)", async () => {
    const application = app(); const copied = await login(application);
    state.revocationReadFails = true;
    const denied = await session(application, copied);
    expect(denied.status).toBe(401);
    expect(denied.body.error).toContain("could not be verified");
    state.revocationReadFails = false;
    expect((await session(application, copied)).status).toBe(200);
  });
  it("honors an administrator's explicit revocation of a staff bearer", async () => {
    const application = app(); const token = generateStaffToken({ agentId: "agent-1", role: "agent", unitId: "DZ16" });
    expect((await supertest(application).get("/auth/session").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect(await revokeAdminSession(token, "incident-response")).toBe("revoked");
    expect((await supertest(application).get("/auth/session").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });
});
describe("MWARE-1 known revocations survive storage loss", () => {
  it.each(["null-read", "no-database"])("keeps a previously observed revoked token denied: %s", async (outage) => {
    const application = app(); const token = generateAdminToken();
    // Populate via a durable read, independently of the revocation writer.
    const { default: jwt } = await import("jsonwebtoken");
    const payload = jwt.decode(token) as { jti: string };
    state.revocations.set(payload.jti, { exp: Date.now() + 3600000 });
    const request = () => supertest(application).get("/auth/session").set("Authorization", `Bearer ${token}`);
    expect((await request()).status).toBe(401);
    state.readNull = true; if (outage === "no-database") state.dbPresent = false;
    expect((await request()).status).toBe(401);
    expect((await supertest(application).get("/auth/session").set("Authorization", `Bearer ${generateAdminToken()}`)).status).toBe(200);
  });
});
describe("USR-1 commander management boundary", () => {
  it.each([{ password: "ReplacementPass123" }, { isActive: false }])("forbids changing a peer commander: %j", async (change) => {
    state.users.set("commander-1", { agentId: "commander-1", role: "commander", unitId: "DZ16", isActive: true });
    state.users.set("commander-2", { agentId: "commander-2", role: "commander", unitId: "DZ16", isActive: true });
    const token = generateStaffToken({ agentId: "commander-1", role: "commander", unitId: "DZ16" });
    const before = { ...state.users.get("commander-2") };
    const response = await supertest(app()).put("/users/commander-2").set("Authorization", `Bearer ${token}`).send(change);
    expect(response.status).toBe(403); expect(state.users.get("commander-2")).toEqual(before);
    expect((await supertest(app()).put("/users/agent-1").set("Authorization", `Bearer ${token}`).send(change)).status).toBe(200);
    expect((await supertest(app()).put("/users/commander-2").set("Authorization", `Bearer ${generateAdminToken("superadmin")}`).send(change)).status).toBe(200);
  });
});
