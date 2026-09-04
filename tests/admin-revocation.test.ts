/**
 * v2.6.0 — S-M1/S-M3 admin session hardening:
 *   - generateAdminToken() now mints a jti for every admin session
 *   - revokeAdminSession() writes a durable adminRevocations entry
 *   - requireAuth rejects a revoked jti (fail-open ONLY on register outage)
 *   - legacy jti-less tokens keep working until natural expiry
 *   - the central-command gate issues a DISTINCT "superadmin" role (S-M3)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import jwt from "jsonwebtoken";
import config from "../server/config.js";

const state = vi.hoisted(() => ({
  dbPresent: false,
  docGet: vi.fn(),
  docSet: vi.fn(async () => true),
}));

vi.mock("../server/firebase.js", () => ({
  getDb: () => (state.dbPresent ? { __fake: true } : null),
  isAdminDb: () => state.dbPresent,
}));

vi.mock("../server/fs.js", () => ({
  docGet: state.docGet,
  docSet: state.docSet,
  collectionGet: vi.fn(async () => null),
}));

import {
  generateAdminToken,
  generateStaffToken,
  revokeAdminSession,
  requireAuth,
  requireAdmin,
} from "../server/middleware.js";

function appWith(handler?: (req: any, res: any) => void) {
  const app = express();
  app.use(express.json());
  app.get("/protected", requireAuth, (req: any, res) => {
    if (handler) return handler(req, res);
    res.json({ role: req.admin.role });
  });
  app.get("/admin-only", requireAdmin, (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  state.dbPresent = false;
  state.docGet.mockReset();
  state.docGet.mockResolvedValue(null);
  state.docSet.mockClear();
  state.docSet.mockResolvedValue(true);
});

describe("S-M1: admin token jti + revocation register", () => {
  it("mints admin tokens carrying a jti and the requested role", () => {
    const admin = generateAdminToken("admin");
    const superadmin = generateAdminToken("superadmin");
    const decodedAdmin = jwt.verify(admin, config.jwtSecret) as any;
    const decodedSuper = jwt.verify(superadmin, config.jwtSecret) as any;
    expect(decodedAdmin.role).toBe("admin");
    expect(decodedSuper.role).toBe("superadmin");
    expect(typeof decodedAdmin.jti).toBe("string");
    expect(decodedAdmin.jti).toHaveLength(32);
    expect(decodedSuper.jti).not.toBe(decodedAdmin.jti);
  });

  it("accepts an admin session whose jti is NOT in the register (no db)", async () => {
    const res = await supertest(appWith())
      .get("/protected")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");
    expect(state.docGet).not.toHaveBeenCalled();
  });

  it("REJECTS a revoked jti with 401 once a database exists", async () => {
    state.dbPresent = true;
    state.docGet.mockResolvedValue({ revokedAt: new Date().toISOString(), exp: Date.now() + 3600_000 });
    const res = await supertest(appWith())
      .get("/protected")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("revoked");
    expect(state.docGet).toHaveBeenCalledWith("adminRevocations", expect.any(String));
  });

  it("ignores EXPIRED revocation entries (the token is dead anyway)", async () => {
    state.dbPresent = true;
    state.docGet.mockResolvedValue({ revokedAt: new Date().toISOString(), exp: Date.now() - 1000 });
    const res = await supertest(appWith())
      .get("/protected")
      .set("Authorization", `Bearer ${generateAdminToken("superadmin")}`);
    expect(res.status).toBe(200);
  });

  it("fails OPEN when the register itself errors (control-room availability)", async () => {
    state.dbPresent = true;
    state.docGet.mockRejectedValue(new Error("firestore down"));
    const res = await supertest(appWith())
      .get("/protected")
      .set("Authorization", `Bearer ${generateAdminToken("admin")}`);
    expect(res.status).toBe(200);
  });

  it("v2.15.0: a token SEEN REVOKED stays denied even when the register later goes down", async () => {
    state.dbPresent = true;
    const token = generateAdminToken("admin");
    state.docGet.mockResolvedValueOnce(null); // first check: not revoked
    await supertest(appWith()).get("/protected").set("Authorization", `Bearer ${token}`);
    state.docGet.mockResolvedValueOnce({ revokedAt: new Date().toISOString(), exp: Date.now() + 3_600_000 });
    await supertest(appWith())
      .get("/protected")
      .set("Authorization", `Bearer ${token}`)
      .expect((res) => { if (res.status !== 401) throw new Error("expected revoked 401, got " + res.status); });
    // Register outage AFTER the revocation was observed: last-known state
    // governs — an outage can no longer resurrect a stolen session.
    state.docGet.mockRejectedValue(new Error("register down"));
    const res = await supertest(appWith()).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("revokeAdminSession persists a revocation entry carrying the token's exp", async () => {
    const token = generateAdminToken("admin");
    const decoded = jwt.decode(token) as any;
    const ok = await revokeAdminSession(token, "incident-response");
    expect(ok).toBe(true);
    expect(state.docSet).toHaveBeenCalledWith(
      "adminRevocations",
      decoded.jti,
      expect.objectContaining({ reason: "incident-response", exp: decoded.exp * 1000 })
    );
  });

  it("revokeAdminSession is a harmless no-op for legacy jti-less tokens", async () => {
    const legacy = jwt.sign({ role: "admin" }, config.jwtSecret, { expiresIn: "24h" });
    const ok = await revokeAdminSession(legacy, "logout");
    expect(ok).toBe(false);
    expect(state.docSet).not.toHaveBeenCalled();
  });

  it("legacy jti-less admin tokens still pass requireAuth (never worse than before)", async () => {
    state.dbPresent = true; // even WITH a db, no jti means nothing to check
    const legacy = jwt.sign({ role: "admin" }, config.jwtSecret, { expiresIn: "24h" });
    const res = await supertest(appWith()).get("/protected").set("Authorization", `Bearer ${legacy}`);
    expect(res.status).toBe(200);
    expect(state.docGet).not.toHaveBeenCalled();
  });
});

describe("S-M3: distinct superadmin role", () => {
  it("superadmin sessions pass requireAdmin and announce their role", async () => {
    const gate = await supertest(appWith())
      .get("/admin-only")
      .set("Authorization", `Bearer ${generateAdminToken("superadmin")}`);
    expect(gate.status).toBe(200);
    const session = await supertest(appWith((req, res) => res.json({ role: req.admin.role })))
      .get("/protected")
      .set("Authorization", `Bearer ${generateAdminToken("superadmin")}`);
    expect(session.body.role).toBe("superadmin");
  });

  it("staff tokens are untouched by the admin-revocation path", async () => {
    state.dbPresent = true;
    state.docGet.mockResolvedValue({ agentId: "c1", role: "commander", unitId: "u1", isActive: true });
    const res = await supertest(appWith())
      .get("/protected")
      .set("Authorization", `Bearer ${generateStaffToken({ role: "commander", agentId: "c1", unitId: "u1" })}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("commander");
    // The register is never consulted for staff sessions.
    expect(state.docGet).toHaveBeenCalledWith("users", "c1");
  });
});
