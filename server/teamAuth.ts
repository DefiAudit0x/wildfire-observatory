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
 */
const TEAM_TOKEN_TTL_SECONDS = 12 * 60 * 60; // one shift

export interface TeamMemberTokenPayload {
  scope: "team-member";
  memberId: string;
  teamId: string;
}

export function createTeamMemberToken(memberId: string, teamId: string): string {
  const payload: TeamMemberTokenPayload = { scope: "team-member", memberId, teamId };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: TEAM_TOKEN_TTL_SECONDS });
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
