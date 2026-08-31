import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

/**
 * Team Mode tokens — scope separation is the whole point (C2 principle).
 * A team-member token authorizes ONLY the team GPS channel; it must never
 * pass the staff/admin gate, exactly like mesh tokens before it. The same
 * holds for public-principal tokens (previously unverified surface).
 */

import { createTeamMemberToken, verifyTeamMemberToken } from "../server/teamAuth.js";
import { createMeshToken } from "../server/mesh-auth.js";
import { createPublicPrincipalToken } from "../server/public-principal.js";
import { generateAdminToken, generateStaffToken, requireAdmin, requireAuth } from "../server/middleware.js";
import config from "../server/config.js";

function appWithGate(gate: express.RequestHandler) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.get("/gated", gate, (_req, res) => res.json({ ok: true }));
  return app;
}

describe("team-member token — shape and verification", () => {
  it("round-trips memberId and teamId", () => {
    const token = createTeamMemberToken("tm-abc123", "team-abc123");
    const payload = verifyTeamMemberToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.scope).toBe("team-member");
    expect(payload!.memberId).toBe("tm-abc123");
    expect(payload!.teamId).toBe("team-abc123");
  });

  it("rejects garbage and foreign tokens", () => {
    expect(verifyTeamMemberToken("not-a-jwt")).toBeNull();
    expect(verifyTeamMemberToken(createMeshToken("someone"))).toBeNull();
    expect(verifyTeamMemberToken(createPublicPrincipalToken())).toBeNull();
    expect(verifyTeamMemberToken(generateAdminToken())).toBeNull();
  });

  it("rejects payloads missing memberId or teamId", () => {
    const forged = jwt.sign({ scope: "team-member", memberId: "tm-x" }, config.jwtSecret, { expiresIn: "1h" });
    expect(verifyTeamMemberToken(forged)).toBeNull();
    const forged2 = jwt.sign({ scope: "team-member", teamId: "team-x" }, config.jwtSecret, { expiresIn: "1h" });
    expect(verifyTeamMemberToken(forged2)).toBeNull();
  });
});

describe("scope separation at the session gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requireAdmin accepts an admin token", async () => {
    const res = await supertest(appWithGate(requireAdmin))
      .get("/gated")
      .set("Authorization", `Bearer ${generateAdminToken()}`);
    expect(res.status).toBe(200);
  });

  it("requireAdmin rejects a team-member token (403, scope error)", async () => {
    const res = await supertest(appWithGate(requireAdmin))
      .get("/gated")
      .set("Authorization", `Bearer ${createTeamMemberToken("tm-abc", "team-abc")}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a session credential/i);
  });

  it("requireAuth rejects a team-member token — the gate below requireAdmin too", async () => {
    const res = await supertest(appWithGate(requireAuth))
      .get("/gated")
      .set("Authorization", `Bearer ${createTeamMemberToken("tm-abc", "team-abc")}`);
    expect(res.status).toBe(403);
  });

  it("mesh tokens are still rejected with their original message (C2 regression guard)", async () => {
    const res = await supertest(appWithGate(requireAuth))
      .get("/gated")
      .set("Authorization", `Bearer ${createMeshToken("someone")}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/mesh tokens are not session credentials/i);
  });

  it("public-principal tokens are rejected as session credentials", async () => {
    const res = await supertest(appWithGate(requireAuth))
      .get("/gated")
      .set("Authorization", `Bearer ${createPublicPrincipalToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a session credential/i);
  });

  it("staff tokens still pass (no false positive from the scope hardening)", async () => {
    const staff = generateStaffToken({ role: "agent", agentId: "agent-1" });
    const res = await supertest(appWithGate(requireAuth)).get("/gated").set("Authorization", `Bearer ${staff}`);
    // No Firestore in tests → agentId revalidation is skipped → 200.
    expect(res.status).toBe(200);
  });
});
