import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { createHash, randomBytes, randomInt } from "node:crypto";
import logger from "../logger.js";
import { collectionGet, docGet, docSet, docUpdate, invalidateCollectionCache, invalidateDocCache } from "../fs.js";
import { joinTeamAtomically, setMissionPhaseAtomically } from "../atomic.js";
import { requireAdmin } from "../middleware.js";
import { getPublicPrincipal, issuePublicPrincipal } from "../public-principal.js";
import { createTeamMemberToken, teamTokenFromRequest } from "../teamAuth.js";
import { isOnline, listPositions, recordHeartbeat, removeMember, snapshotIfDue } from "../teamRegistry.js";
import { NA_BOUNDS } from "../geo.js";

/**
 * Team Mode (Phase 1) — registered field teams, join codes, member GPS.
 *
 * Identity model (M15 applied where it counts): the SECURITY identity of a
 * team member is the server-issued public principal bound at join time plus
 * the scope-separated team-member token minted here. The device id the client
 * sends anywhere else stays a display/lookup label — never an authority.
 *
 * Firestore (all four collections are server-only in firestore.rules):
 *  - teams/{teamId}            registered team entity (admin CRUD)
 *  - teamJoinCodes/{code}      capability doc: the code IS the doc id
 *  - teamMembers/{memberId}    deterministic per (principal, team) member
 *  - teamMissions/{teamId}     written by the SOS dispatch transaction
 */
const router = Router();

const TEAM_TYPES = ["protection_civile", "volunteers"] as const;

/** Unambiguous read-aloud alphabet (no 0/O, 1/I/L) for field use by radio. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return code;
}

/**
 * Normalizes user-typed codes: uppercase, drop separators/spaces. The
 * generation alphabet deliberately excludes 0/1/I/L/O, so typed-in lookalike
 * glyphs simply never match (404) — mapping them to "equivalents" would only
 * corrupt valid-length codes into equally-invalid ones.
 */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

const createTeamSchema = z.object({
  name: z.string().trim().min(2).max(80),
  nameAr: z.string().trim().min(2).max(120),
  type: z.enum(TEAM_TYPES),
  baseLat: z.coerce.number().finite().min(-90).max(90).optional(),
  baseLng: z.coerce.number().finite().min(-180).max(180).optional(),
});

const joinCodeSchema = z.object({
  maxUses: z.coerce.number().int().min(1).max(200).optional(),
  ttlHours: z.coerce.number().int().min(1).max(168).optional(),
});

const joinSchema = z.object({
  code: z.string().trim().min(4).max(24),
  name: z.string().trim().min(2).max(40),
});

const heartbeatSchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  accuracy: z.coerce.number().finite().min(0).max(10_000).optional(),
  heading: z.coerce.number().finite().min(0).max(360).optional(),
  speed: z.coerce.number().finite().min(0).max(80).optional(),
  batteryPct: z.coerce.number().finite().min(0).max(100).optional(),
});

const missionPhaseSchema = z.object({
  phase: z.literal("on_scene"),
});

// Join is a capability redemption on a 40-bit code: 10 attempts/hour/IP makes
// online guessing hopeless while a village fire station re-registering three
// vehicles never notices the limit.
const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many join attempts. Try again later." },
});

// GPS streaming: generous per-IP, plus a per-member minimum interval below.
const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many team heartbeats from this address." },
});

const HEARTBEAT_MEMBER_MIN_MS = 3000;
const heartbeatMemberTimes = new Map<string, number>();
const heartbeatSweep = setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [memberId, last] of heartbeatMemberTimes) if (last < cutoff) heartbeatMemberTimes.delete(memberId);
}, 60 * 1000);
heartbeatSweep.unref();

function inNorthAfricaBounds(lat: number, lng: number): boolean {
  return (
    lat >= NA_BOUNDS.minLat && lat <= NA_BOUNDS.maxLat &&
    lng >= NA_BOUNDS.minLng && lng <= NA_BOUNDS.maxLng
  );
}

function activeMissionOf(mission: any): { sosId: string; phase: string; since: number } | null {
  if (!mission || !mission.sosId || mission.phase === "cleared") return null;
  return { sosId: mission.sosId, phase: mission.phase, since: Number(mission.since) || 0 };
}

/**
 * POST /api/teams — register a field team (command center).
 * Returns the created entity; join codes are minted separately so code
 * rotation stays an explicit dispatcher decision.
 */
router.post("/", requireAdmin, async (req: Request, res: Response) => {
  const parsed = createTeamSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid team fields" });
    return;
  }
  const { name, nameAr, type, baseLat, baseLng } = parsed.data;
  if (
    (baseLat !== undefined || baseLng !== undefined) &&
    (baseLat === undefined || baseLng === undefined || !inNorthAfricaBounds(baseLat, baseLng))
  ) {
    res.status(400).json({ error: "Base coordinates are outside the coverage area" });
    return;
  }
  const teamId = `team-${randomBytes(4).toString("hex")}`;
  const team = {
    teamId,
    name,
    nameAr,
    type,
    baseLat: baseLat ?? null,
    baseLng: baseLng ?? null,
    active: true,
    createdAt: Date.now(),
    createdBy: (req as any).admin?.agentId || "admin",
  };
  const ok = await docSet("teams", teamId, team);
  if (!ok) {
    res.status(503).json({ code: "TEAMS_STORAGE_UNAVAILABLE", error: "Teams storage unavailable" });
    return;
  }
  res.status(201).json(team);
});

/**
 * GET /api/teams — command-center roster: registered teams merged with the
 * live position registry and each team's active mission.
 */
router.get("/", requireAdmin, async (_req: Request, res: Response) => {
  const teams = (await collectionGet("teams")) || [];
  const members = (await collectionGet("teamMembers")) || [];
  const live = listPositions();
  const liveByMember = new Map(live.map((p) => [p.memberId, p]));

  const payload = [] as any[];
  for (const team of teams) {
    if (team?.active === false) continue;
    const teamId = team.teamId || team.id;
    const teamMembers = members
      .filter((m: any) => m.teamId === teamId && m.active !== false)
      .map((m: any) => {
        const position = liveByMember.get(m.memberId);
        return {
          memberId: m.memberId,
          name: m.name,
          joinedAt: m.joinedAt || null,
          lastSeenAt: position?.lastSeen ?? m.lastSeenAt ?? null,
          online: position ? isOnline(position.lastSeen) : false,
          lat: position?.lat ?? m.lastKnownLat ?? null,
          lng: position?.lng ?? m.lastKnownLng ?? null,
          accuracy: position?.accuracy ?? null,
          heading: position?.heading ?? null,
          speed: position?.speed ?? null,
          batteryPct: position?.batteryPct ?? null,
          trail: position?.trail ?? [],
        };
      })
      .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
    const mission = activeMissionOf(await docGet("teamMissions", teamId));
    payload.push({
      teamId,
      name: team.name,
      nameAr: team.nameAr,
      type: team.type,
      baseLat: team.baseLat ?? null,
      baseLng: team.baseLng ?? null,
      members: teamMembers,
      activeMission: mission,
    });
  }
  payload.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  res.json(payload);
});

/**
 * POST /api/teams/:id/join-code — mint (and rotate) the team's join code.
 * Rotation semantics: creating a new code revokes every previous active code
 * of the same team, so at most one live capability exists per team.
 */
router.post("/:id/join-code", requireAdmin, async (req: Request, res: Response) => {
  const teamId = String(req.params.id || "");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(teamId)) {
    res.status(400).json({ error: "Invalid team id" });
    return;
  }
  const team = await docGet("teams", teamId);
  if (!team || team.active === false) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  const parsed = joinCodeSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid join-code options" });
    return;
  }
  const maxUses = parsed.data.maxUses ?? 12;
  const ttlHours = parsed.data.ttlHours ?? 24;
  const now = Date.now();
  const code = generateJoinCode();
  const expiresAt = now + ttlHours * 60 * 60 * 1000;

  const existing = (await collectionGet("teamJoinCodes")) || [];
  for (const old of existing) {
    if (old?.teamId === teamId && old?.revoked !== true) {
      await docUpdate("teamJoinCodes", old.code || old.id, { revoked: true, revokedAt: now });
    }
  }
  const stored = await docSet("teamJoinCodes", code, {
    code,
    teamId,
    createdAt: now,
    expiresAt,
    maxUses,
    uses: 0,
    revoked: false,
    createdBy: (req as any).admin?.agentId || "admin",
  });
  if (!stored) {
    res.status(503).json({ code: "TEAMS_STORAGE_UNAVAILABLE", error: "Teams storage unavailable" });
    return;
  }
  logger.info({ teamId, expiresAt, maxUses }, "Team join code minted");
  res.status(201).json({ code, teamId, expiresAt, maxUses });
});

/**
 * POST /api/teams/join — field device redemption. Public (rate-limited).
 * Issues the public principal when absent, then runs the atomic redemption:
 * fresh code re-validation + use budget increment + member upsert in ONE
 * transaction, so two devices racing the last remaining use cannot both pass.
 * The member id is deterministic per (principal, team) — rejoining the same
 * team reactivates the same member instead of duplicating it.
 *
 * CSRF note: a RE-join from a device that already holds a public_principal
 * cookie goes through the global CSRF origin check. Browser devices pass it
 * (same-origin Origin header); native clients pass it by attaching their
 * (even expired) team token as `Authorization: Bearer …`, which the global
 * guard treats as an explicitly credentialed request.
 */
router.post("/join", joinLimiter, async (req: Request, res: Response) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid join fields" });
    return;
  }
  const code = normalizeCode(parsed.data.code);
  const name = parsed.data.name.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (code.length !== CODE_LENGTH || !name) {
    res.status(400).json({ error: "Invalid join fields" });
    return;
  }

  let principal = getPublicPrincipal(req);
  if (!principal) principal = issuePublicPrincipal(res);
  const subject = principal.subject;

  // Fast-fail on the cached doc; the transaction below is the authority.
  const codeDoc = await docGet("teamJoinCodes", code);
  const teamId = codeDoc?.teamId;
  if (!teamId || typeof teamId !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(teamId)) {
    res.status(404).json({ error: "رمز الانضمام غير صالح (Invalid join code)" });
    return;
  }
  const team = await docGet("teams", teamId);
  if (!team || team.active === false) {
    res.status(404).json({ error: "رمز الانضمام غير صالح (Invalid join code)" });
    return;
  }

  const memberId = `tm-${createHash("sha256").update(`${subject}:${teamId}`).digest("hex").slice(0, 16)}`;
  const result = await joinTeamAtomically(code, memberId, {
    memberId,
    teamId,
    name,
    principal: subject,
  });

  if (result.status === "joined") {
    invalidateCollectionCache("teamJoinCodes");
    invalidateDocCache("teamJoinCodes", code);
    invalidateCollectionCache("teamMembers");
    invalidateDocCache("teamMembers", memberId);
  }

  if (result.status === "code-invalid" || result.status === "code-expired" || result.status === "code-exhausted") {
    res.status(404).json({ error: "رمز الانضمام غير صالح أو منتهي (Invalid or expired join code)", code: result.status });
    return;
  }
  if (result.status === "team-inactive") {
    res.status(409).json({ error: "هذا الفريق غير مفعل (Team is deactivated)", code: result.status });
    return;
  }
  if (result.status !== "joined") {
    res.status(503).json({ code: "TEAMS_STORAGE_UNAVAILABLE", error: "Teams storage unavailable" });
    return;
  }

  const token = createTeamMemberToken(memberId, teamId);
  const mission = activeMissionOf(await docGet("teamMissions", teamId));
  logger.info({ memberId, teamId }, "Team member joined");
  res.json({
    memberId,
    teamId,
    teamName: team.name,
    teamNameAr: team.nameAr,
    name,
    token,
    tokenTtlSeconds: 12 * 60 * 60,
    mission,
  });
});

/**
 * POST /api/teams/heartbeat — team-member GPS ping (Bearer team token).
 * Updates the live registry, snapshots to Firestore at most once per 5 min,
 * and returns the active mission so the field app learns its target.
 */
router.post("/heartbeat", heartbeatLimiter, async (req: Request, res: Response) => {
  const token = teamTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Team session required" });
    return;
  }
  const parsed = heartbeatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid heartbeat fields" });
    return;
  }
  const { lat, lng, accuracy, heading, speed, batteryPct } = parsed.data;
  if (!inNorthAfricaBounds(lat, lng)) {
    res.status(400).json({ error: "Coordinates are outside the coverage area" });
    return;
  }

  const now = Date.now();
  const lastSeen = heartbeatMemberTimes.get(token.memberId);
  if (lastSeen !== undefined && now - lastSeen < HEARTBEAT_MEMBER_MIN_MS) {
    res.status(429).json({ error: "Heartbeat too frequent for this member." });
    return;
  }

  const member = await docGet("teamMembers", token.memberId);
  if (!member || member.teamId !== token.teamId) {
    res.status(403).json({ code: "MEMBER_INVALID", error: "Team membership not found" });
    return;
  }
  if (member.active === false) {
    res.status(403).json({ code: "MEMBER_INACTIVE", error: "Membership is deactivated" });
    return;
  }
  const team = await docGet("teams", token.teamId);
  if (!team || team.active === false) {
    res.status(403).json({ code: "TEAM_INACTIVE", error: "Team is deactivated" });
    return;
  }

  heartbeatMemberTimes.set(token.memberId, now);
  recordHeartbeat({
    memberId: token.memberId,
    teamId: token.teamId,
    name: member.name,
    lat,
    lng,
    accuracy: accuracy ?? null,
    heading: heading ?? null,
    speed: speed ?? null,
    batteryPct: batteryPct ?? null,
    now,
  });
  snapshotIfDue(token.memberId, token.teamId, now);

  const mission = activeMissionOf(await docGet("teamMissions", token.teamId));
  res.json({ ok: true, serverTime: now, heartbeatIntervalMs: 15_000, mission });
});

/**
 * POST /api/teams/leave — member opts out (Bearer team token). Deactivates
 * the membership and drops the live position immediately.
 */
router.post("/leave", async (req: Request, res: Response) => {
  const token = teamTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Team session required" });
    return;
  }
  const member = await docGet("teamMembers", token.memberId);
  if (!member || member.teamId !== token.teamId) {
    res.status(403).json({ error: "Team membership not found" });
    return;
  }
  await docUpdate("teamMembers", token.memberId, { active: false, leftAt: Date.now() });
  removeMember(token.memberId);
  res.json({ ok: true });
});

/**
 * POST /api/teams/mission/phase — field team reports arrival (on_scene).
 * Clearing a mission stays admin-only (SOS resolve frees teams).
 */
router.post("/mission/phase", async (req: Request, res: Response) => {
  const token = teamTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Team session required" });
    return;
  }
  const parsed = missionPhaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid mission phase" });
    return;
  }
  const result = await setMissionPhaseAtomically(token.teamId, parsed.data.phase);
  if (result.status === "no-active-mission") {
    res.status(409).json({ code: "NO_ACTIVE_MISSION", error: "No active mission for this team" });
    return;
  }
  if (result.status !== "updated") {
    res.status(503).json({ code: "TEAMS_STORAGE_UNAVAILABLE", error: "Teams storage unavailable" });
    return;
  }
  invalidateCollectionCache("teamMissions");
  invalidateDocCache("teamMissions", token.teamId);
  res.json({ ok: true, mission: result.mission });
});

/**
 * DELETE /api/teams/:id/members/:memberId — dispatcher removes (deactivates)
 * a member, e.g. a device lost or a reassignment. The live position drops
 * immediately; the member doc stays as history with active:false.
 */
router.delete("/:id/members/:memberId", requireAdmin, async (req: Request, res: Response) => {
  const teamId = String(req.params.id || "");
  const memberId = String(req.params.memberId || "");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(teamId) || !/^tm-[0-9a-f]{16}$/.test(memberId)) {
    res.status(400).json({ error: "Invalid identifiers" });
    return;
  }
  const member = await docGet("teamMembers", memberId);
  if (!member || member.teamId !== teamId) {
    res.status(404).json({ error: "Member not found in this team" });
    return;
  }
  await docUpdate("teamMembers", memberId, { active: false, removedAt: Date.now() });
  removeMember(memberId);
  logger.info({ memberId, teamId }, "Team member removed by dispatcher");
  res.json({ ok: true });
});

export default router;
