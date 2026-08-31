import jwt from "jsonwebtoken";
import config from "./config.js";

/**
 * Team-member token — the credential a field device earns by presenting a
 * valid team join code. Scope-separated like the mesh token (C2): it
 * authorizes ONLY the team GPS channel (heartbeat, leave, mission phase),
 * never staff/admin surfaces.
 *
 * Lifecycle: minted at join time (POST /api/teams/join), TTL covers one
 * operational shift; a device that keeps the join code valid re-joins to
 * refresh. The server independently fail-closes on the member record
 * (deactivated member or deactivated team → token is dead even if unexpired).
 *
 * B1 revocation: every token carries `gen` — the member's token generation
 * at mint time. Dispatcher removal bumps `teamMembers/{id}.tokenGen`, so ALL
 * previously issued tokens of that member go stale instantly (403
 * MEMBER_REVOKED at the gates) even while unexpired, and even if the member
 * row is later reactivated by a legitimate rejoin.
 */
const TEAM_TOKEN_TTL_SECONDS = 12 * 60 * 60; // one shift

export interface TeamMemberTokenPayload {
  scope: "team-member";
  memberId: string;
  teamId: string;
  gen?: number;
}

export function createTeamMemberToken(memberId: string, teamId: string, tokenGen = 0): string {
  const payload: TeamMemberTokenPayload = { scope: "team-member", memberId, teamId, gen: tokenGen };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: TEAM_TOKEN_TTL_SECONDS });
}

/**
 * Token-generation gate: TRUE means the token predates (or postdates) the
 * member's current generation — i.e. it was issued before a removal bump and
 * must be rejected. Tokens minted before B1 carry no `gen` and are treated
 * as generation 0, which still mismatches any bumped member (≥1).
 */
export function isTokenGenerationStale(token: TeamMemberTokenPayload, member: { tokenGen?: unknown } | null): boolean {
  const tokenGen = Number(token.gen ?? 0);
  const memberGen = Number(member?.tokenGen) || 0;
  return tokenGen !== memberGen;
}

export function verifyTeamMemberToken(token: string): TeamMemberTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as TeamMemberTokenPayload;
    if (
      !decoded ||
      decoded.scope !== "team-member" ||
      typeof decoded.memberId !== "string" ||
      !decoded.memberId ||
      typeof decoded.teamId !== "string" ||
      !decoded.teamId
    ) {
      return null;
    }
    if (decoded.gen !== undefined && (typeof decoded.gen !== "number" || !Number.isFinite(decoded.gen) || decoded.gen < 0)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/** Extracts and verifies the team token from an Authorization: Bearer header. */
export function teamTokenFromRequest(req: { headers: { authorization?: string | string[] | undefined } }): TeamMemberTokenPayload | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return verifyTeamMemberToken(header.slice("Bearer ".length).trim());
}
