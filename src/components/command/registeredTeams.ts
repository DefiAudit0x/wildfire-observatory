/**
 * Team Mode (Phase 1) — client types for the registered-teams API
 * (GET /api/teams). Shapes mirror server/routes/teams.ts; this file is the
 * single source for the command-center UI. Server-only data never flows
 * through the public dataset validators — this plane is admin-session gated.
 */

export interface TeamMemberLive {
  memberId: string;
  name: string;
  joinedAt: number | null;
  lastSeenAt: number | null;
  online: boolean;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  batteryPct: number | null;
  trail: { lat: number; lng: number; t: number }[];
}

export interface ActiveMission {
  sosId: string;
  phase: string;
  since: number;
}

export interface RegisteredTeam {
  teamId: string;
  name: string;
  nameAr: string;
  type: "protection_civile" | "volunteers";
  baseLat: number | null;
  baseLng: number | null;
  members: TeamMemberLive[];
  activeMission: ActiveMission | null;
}

export interface JoinCodeIssued {
  code: string;
  teamId: string;
  expiresAt: number;
  maxUses: number;
}

/** A member flattened for the command map. */
export interface MapTeamMember {
  memberId: string;
  name: string;
  online: boolean;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  batteryPct: number | null;
  lastSeen: number | null;
  trail: { lat: number; lng: number; t: number }[];
  teamId: string;
  teamName: string;
  teamType: "protection_civile" | "volunteers";
}
