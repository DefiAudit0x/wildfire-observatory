import { Request, Response, Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { createHash, randomBytes, randomInt } from "node:crypto";
import logger from "../logger.js";
import { collectionGet, docGet, docSet, docUpdate, docDelete, docDeleteFields, incrementDocField, invalidateCollectionCache, invalidateDocCache } from "../fs.js";
import { joinTeamAtomically, setMissionPhaseAtomically, clearTeamMissionAtomically, setPrincipalBlocked } from "../atomic.js";
import { requireAdmin } from "../middleware.js";
import { getPublicPrincipal, issuePublicPrincipal, renewPublicPrincipal } from "../public-principal.js";
import { createTeamMemberToken, isTokenGenerationStale, teamTokenFromRequest } from "../teamAuth.js";
import { isOnline, listPositions, recordHeartbeat, removeMember, snapshotIfDue } from "../teamRegistry.js";
import { NA_BOUNDS, getHaversineDistance, saneCoord } from "../geo.js";

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
  // F10: the client's own GPS fix timestamp. Without it a device that lost
  // its fix keeps re-sending the SAME stale coordinates every beat and the
  // command map renders a moving member that may have been dark for an hour.
  // Absent on legacy clients — treated as "unknown age", never fabricated.
  fixTimeMs: z.coerce.number().finite().int().nonnegative().optional(),
});

const missionPhaseSchema = z
  .object({
    phase: z.literal("on_scene"),
    // Phase 3 — optional arrival evidence. When present, the route verifies
    // the geometry SERVER-side against the mission target before flipping;
    // the bare {phase} body keeps the Phase-1 self-report contract (manual
    // button, dispatcher-verified on the map).
    lat: z.coerce.number().finite().min(-90).max(90).optional(),
    lng: z.coerce.number().finite().min(-180).max(180).optional(),
    accuracy: z.coerce.number().finite().min(0).max(10_000).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: "Arrival coordinates must come in pairs",
  });

/**
 * Phase 3 — arrival radius. Deliberately tight: GPS at a wildfire scene reads
 * 20–40m under smoke/terrain, so 50m admits honest fixes while a parking-lot
 * mistake or a driving-by fix stays out. The client (web + native) must see
 * TWO consecutive in-range fixes before it even attempts the flip — one stray
 * GPS jump is not an arrival. Mirror constants live in teamSession.ts and
 * TeamLocationLogic.kt; ARCHITECTURE.md §5.5 documents the doctrine.
 */
const ARRIVAL_RADIUS_M = 50;
/**
 * Phase 3 — anti-fabrication slack: the evidence fix must be consistent with
 * the member's LIVE registry position (the one the heartbeat route just
 * recorded server-side). A client fabricating an on-target fix while its real
 * beats come from kilometres away fails this check. 300m absorbs a walking
 * member's drift between the beat and the flip; it cannot absorb a fabricated
 * fix from another wilaya.
 */
const ARRIVAL_EVIDENCE_MATCH_M = 300;

const updateTeamSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  nameAr: z.string().trim().min(2).max(120).optional(),
  active: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

const blockPrincipalSchema = z.object({
  principal: z.string().trim().regex(/^[A-Za-z0-9_-]{6,128}$/, "Invalid principal id"),
  blocked: z.boolean(),
});

/**
 * B1: the shared token-generation gate for the three member routes. A token
 * minted BEFORE the member's current generation (i.e. before a dispatcher
 * removal bumped tokenGen) is rejected even while unexpired and even if a
 * later rejoin reactivated the member row.
 */
function isMemberTokenRevoked(token: { gen?: number }, member: any): boolean {
  return isTokenGenerationStale(token as any, member);
}

// Join is a capability redemption on a 40-bit code: 10 attempts/hour/IP makes
// online guessing hopeless while a village fire station re-registering three
// vehicles never notices the limit.
const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // F12 (P11): this is the ONLY limiter message that reaches an end user
  // (the join form passes body.error through verbatim) — it must speak the
  // member's language like every other join error, not raw English.
  message: {
    error: "محاولات انضمام كثيرة جداً — انتظر قليلاً قبل إعادة المحاولة (Too many join attempts, try again later).",
  },
});

// GPS streaming: ARC-R3 — co-located teams (CGNAT egress, station Wi-Fi) share
// one public IP; an IP-keyed bucket 429s the ~16th member's GPS stream
// mid-operation. Authenticated members are therefore keyed PER-MEMBER, and the
// IP bucket remains only as the backstop for unauthenticated noise. The
// per-member 3s floor below is the real anti-storm control.
const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = teamTokenFromRequest(req);
    if (token) return `member:${token.memberId}`;
    // ipKeyGenerator: express-rate-limit v8 requires per-subnet normalization
    // for IP-derived keys (IPv6 /64 buckets) instead of the raw address.
    const ip = req.ip ?? "unknown";
    return `ip:${ip === "unknown" ? ip : ipKeyGenerator(ip)}`;
  },
  message: { error: "Too many team heartbeats from this address." },
});

const HEARTBEAT_MEMBER_MIN_MS = 3000;
const heartbeatMemberTimes = new Map<string, number>();
const heartbeatSweep = setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [memberId, last] of heartbeatMemberTimes) if (last < cutoff) heartbeatMemberTimes.delete(memberId);
}, 60 * 1000);
heartbeatSweep.unref();

/**
 * Phase 3: the phase route gained an evidence-verified arrival path — a
 * transaction behind it. Beats are single-flight on the client and the flip
 * fires at most once per mission per member, but a buggy client looping on a
 * 400 would otherwise hammer the tx; 10/min per member is ~6× the honest rate.
 */
const phaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = teamTokenFromRequest(req);
    if (token) return `member:${token.memberId}`;
    const ip = req.ip ?? "unknown";
    return `ip:${ip === "unknown" ? ip : ipKeyGenerator(ip)}`;
  },
  message: { error: "Too many mission updates from this address." },
});

function inNorthAfricaBounds(lat: number, lng: number): boolean {
  return (
    lat >= NA_BOUNDS.minLat && lat <= NA_BOUNDS.maxLat &&
    lng >= NA_BOUNDS.minLng && lng <= NA_BOUNDS.maxLng
  );
}

function activeMissionOf(mission: any): { sosId: string; phase: string; since: number; sosLat: number | null; sosLng: number | null } | null {
  if (!mission || !mission.sosId || mission.phase === "cleared") return null;
  return {
    sosId: mission.sosId,
    phase: mission.phase,
    since: Number(mission.since) || 0,
    // Phase 3: mission target — null on legacy missions (created before the
    // dispatch write gained coordinates) or when the SOS doc held no usable
    // fix. Null disables arrival VERIFICATION; the self-report path is not
    // affected.
    sosLat: saneCoord(mission.sosLat),
    sosLng: saneCoord(mission.sosLng),
  };
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
router.get("/", requireAdmin, async (req: Request, res: Response) => {
  const teams = (await collectionGet("teams")) || [];
  const members = (await collectionGet("teamMembers")) || [];
  const live = listPositions();
  const liveByMember = new Map(live.map((p) => [p.memberId, p]));

  const payload = [] as any[];
  const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";
  for (const team of teams) {
    if (team?.active === false && !includeInactive) continue;
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
      active: team.active !== false,
      blockedPrincipals: Array.isArray(team.blockedPrincipals) ? team.blockedPrincipals : [],
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
  // Phase 3 (Round-C passenger): the codes collection was grow-only — expired
  // and revoked docs accumulated forever. Minting already scans the whole
  // collection for rotation; the same pass now sweeps docs that died more
  // than 7 days ago. Deletion is safe for redemption: the join reads by doc
  // id and reports 404 for anything absent.
  const staleCutoff = now - 7 * 24 * 60 * 60 * 1000;
  for (const old of existing) {
    const id = typeof (old?.code || old?.id) === "string" ? old.code || old.id : "";
    if (!id) continue;
    const dead = old?.revoked === true || Number(old?.expiresAt ?? 0) < now;
    const deadSince = Number(old?.revokedAt ?? old?.expiresAt ?? 0);
    if (dead && deadSince > 0 && deadSince < staleCutoff) {
      await docDelete("teamJoinCodes", id);
      continue;
    }
    if (old?.teamId === teamId && old?.revoked !== true) {
      await docUpdate("teamJoinCodes", id, { revoked: true, revokedAt: now });
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

  // Phase C (principal-cookie ghosts): a returning device's principal is
  // re-issued with a fresh window (same subject — identity continuity),
  // instead of silently dying at day 30 and minting a ghost duplicate member
  // on the next join. First-time devices get a brand-new principal.
  let principal = getPublicPrincipal(req);
  if (principal) renewPublicPrincipal(res, principal.subject);
  else principal = issuePublicPrincipal(res);
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
  if (result.status === "principal-blocked") {
    // B2: the dispatcher blocked this device (lost/reassigned). Same 404 shape
    // as an invalid code — a blocked device learns nothing about the team.
    logger.warn({ memberId, teamId }, "Join rejected: principal is blocked on this team");
    res.status(403).json({ error: "هذا الجهاز محجوب عن الانضمام (Device is blocked)", code: result.status });
    return;
  }
  if (result.status !== "joined") {
    res.status(503).json({ code: "TEAMS_STORAGE_UNAVAILABLE", error: "Teams storage unavailable" });
    return;
  }

  // B1: the token carries the member's CURRENT tokenGen, read inside the
  // redemption transaction — a rejoin after a removal bump mints a fresh-
  // generation token while the device's OLD token stays dead.
  const token = createTeamMemberToken(memberId, teamId, Number(result.tokenGen) || 0);
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
  const { lat, lng, accuracy, heading, speed, batteryPct, fixTimeMs } = parsed.data;
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
    logger.warn({ memberId: token.memberId, teamId: token.teamId }, "Heartbeat rejected: MEMBER_INVALID");
    res.status(403).json({ code: "MEMBER_INVALID", error: "Team membership not found" });
    return;
  }
  if (member.active === false) {
    logger.warn({ memberId: token.memberId, teamId: token.teamId }, "Heartbeat rejected: MEMBER_INACTIVE");
    res.status(403).json({ code: "MEMBER_INACTIVE", error: "Membership is deactivated" });
    return;
  }
  if (isMemberTokenRevoked(token, member)) {
    // B1: token predates the member's current generation (dispatcher removal
    // bumped tokenGen). Dead even though active may be true again after a
    // later rejoin — the rejoining device minted a fresh token instead.
    logger.warn({ memberId: token.memberId, teamId: token.teamId }, "Heartbeat rejected: MEMBER_REVOKED (stale token generation)");
    res.status(403).json({ code: "MEMBER_REVOKED", error: "Membership token has been revoked" });
    return;
  }
  const team = await docGet("teams", token.teamId);
  if (!team || team.active === false) {
    logger.warn({ memberId: token.memberId, teamId: token.teamId }, "Heartbeat rejected: TEAM_INACTIVE");
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
    fixTimeMs: fixTimeMs ?? null,
    now,
  });
  snapshotIfDue(token.memberId, token.teamId, now);

  const mission = activeMissionOf(await docGet("teamMissions", token.teamId));
  res.json({ ok: true, serverTime: now, heartbeatIntervalMs: 15_000, mission });
});

/**
 * POST /api/teams/session — resume a team session WITHOUT a GPS fix (Phase 2).
 *
 * Why it exists: the member panel persists its 12h token (sessionStorage) and
 * needs to restore { team, member, mission } on page reload / WebView restart
 * before any location permission has been granted. The heartbeat cannot serve
 * this — it hard-requires lat/lng. Session probe therefore validates the SAME
 * gate chain as the heartbeat (fail-closed per request, live Firestore state)
 * and returns everything the panel renders, minus any location fields.
 *
 * Cheap by design (2–3 doc reads, no writes) and rate-limited per member.
 */
const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = teamTokenFromRequest(req);
    if (token) return `member:${token.memberId}`;
    const ip = req.ip ?? "unknown";
    return `ip:${ip === "unknown" ? ip : ipKeyGenerator(ip)}`;
  },
  message: { error: "Too many team session probes from this address." },
});

router.post("/session", sessionLimiter, async (req: Request, res: Response) => {
  const token = teamTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Team session required" });
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
  if (isMemberTokenRevoked(token, member)) {
    res.status(403).json({ code: "MEMBER_REVOKED", error: "Membership token has been revoked" });
    return;
  }
  const team = await docGet("teams", token.teamId);
  if (!team || team.active === false) {
    res.status(403).json({ code: "TEAM_INACTIVE", error: "Team is deactivated" });
    return;
  }
  const mission = activeMissionOf(await docGet("teamMissions", token.teamId));
  res.json({
    memberId: token.memberId,
    teamId: token.teamId,
    teamName: team.name,
    teamNameAr: team.nameAr,
    name: member.name,
    mission,
    heartbeatIntervalMs: 15_000,
    serverTime: Date.now(),
  });
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
  if (isMemberTokenRevoked(token, member)) {
    res.status(403).json({ code: "MEMBER_REVOKED", error: "Membership token has been revoked" });
    return;
  }
  await docUpdate("teamMembers", token.memberId, { active: false, leftAt: Date.now() });
  removeMember(token.memberId);
  res.json({ ok: true });
});

/**
 * POST /api/teams/mission/phase — field team reports arrival (on_scene).
 * Clearing a mission stays admin-only (SOS resolve frees teams).
 *
 * ARC-R2: this route used to trust the 12h JWT alone — a REMOVED member (or a
 * member of a deactivated team) kept a valid token and could flip its former
 * team's mission phase at will, misleading dispatch. The gate mirrors the
 * heartbeat route exactly: per-request, fail-closed on live Firestore state.
 */
router.post("/mission/phase", phaseLimiter, async (req: Request, res: Response) => {
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
  const member = await docGet("teamMembers", token.memberId);
  if (!member || member.teamId !== token.teamId) {
    res.status(403).json({ code: "MEMBER_INVALID", error: "Team membership not found" });
    return;
  }
  if (member.active === false) {
    res.status(403).json({ code: "MEMBER_INACTIVE", error: "Membership is deactivated" });
    return;
  }
  if (isMemberTokenRevoked(token, member)) {
    res.status(403).json({ code: "MEMBER_REVOKED", error: "Membership token has been revoked" });
    return;
  }
  const team = await docGet("teams", token.teamId);
  if (!team || team.active === false) {
    res.status(403).json({ code: "TEAM_INACTIVE", error: "Team is deactivated" });
    return;
  }
  // Phase 3 — evidence-verified arrival. When the request carries a GPS fix,
  // the SERVER checks the geometry before flipping (the member's device is
  // never the sole authority on arrival):
  //  1. evidence must sit inside the coverage bounds,
  //  2. evidence must be within ARRIVAL_RADIUS_M of the mission target
  //     (haversine — a GPS drift or a bad fix cannot declare arrival),
  //  3. evidence must be consistent with the member's LIVE registry fix
  //     (anti-fabrication: a device cannot claim on-target coordinates while
  //     its real heartbeats come from kilometres away).
  // Legacy missions (no usable target coords) and evidence-less flips keep
  // the Phase-1 self-report contract — dispatcher-visible on the map either
  // way. The two-consecutive-fixes discipline lives client-side (web loop +
  // native FGS) and is documented in ARCHITECTURE.md §5.5.
  const evidenceLat = parsed.data.lat;
  const evidenceLng = parsed.data.lng;
  if (evidenceLat !== undefined && evidenceLng !== undefined) {
    if (!inNorthAfricaBounds(evidenceLat, evidenceLng)) {
      res.status(400).json({ code: "ARRIVAL_OUT_OF_COVERAGE", error: "Coordinates are outside the coverage area" });
      return;
    }
    const target = activeMissionOf(await docGet("teamMissions", token.teamId));
    if (target && target.sosLat !== null && target.sosLng !== null) {
      const distanceM = getHaversineDistance(evidenceLat, evidenceLng, target.sosLat, target.sosLng) * 1000;
      if (distanceM > ARRIVAL_RADIUS_M) {
        logger.info(
          { memberId: token.memberId, teamId: token.teamId, distanceM: Math.round(distanceM) },
          "Arrival evidence rejected: too far from mission target"
        );
        res.status(400).json({
          code: "ARRIVAL_TOO_FAR",
          error: "أنت لا تزال بعيداً عن موقع البلاغ (Arrival evidence is too far from the SOS location)",
        });
        return;
      }
      const live = listPositions({ teamId: token.teamId }).find((p) => p.memberId === token.memberId);
      if (live && isOnline(live.lastSeen)) {
        const mismatchM = getHaversineDistance(evidenceLat, evidenceLng, live.lat, live.lng) * 1000;
        if (mismatchM > ARRIVAL_EVIDENCE_MATCH_M) {
          logger.warn(
            { memberId: token.memberId, teamId: token.teamId, mismatchM: Math.round(mismatchM) },
            "Arrival evidence rejected: conflicts with live registry position"
          );
          res.status(400).json({
            code: "ARRIVAL_EVIDENCE_CONFLICT",
            error: "إحداثيات الوصول لا تطابق نبضات موقعك (Arrival evidence conflicts with your live position)",
          });
          return;
        }
      }
    }
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
 * PATCH /api/teams/:id — dispatcher levers (B3): rename a team and/or
 * activate/deactivate it. Deactivation was previously DEAD CODE — no endpoint
 * could set active:false, so the guards in join/heartbeat/mission-phase were
 * unreachable and a compromised team entry had no off-switch. Deactivating
 * now: hides the team from the roster, rejects joins (409), kills heartbeats
 * and phase flips (403), and blocks dispatch (404) — without touching
 * member history.
 */
router.patch("/:id", requireAdmin, async (req: Request, res: Response) => {
  const teamId = String(req.params.id || "");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(teamId)) {
    res.status(400).json({ error: "Invalid team id" });
    return;
  }
  const parsed = updateTeamSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid team fields" });
    return;
  }
  const team = await docGet("teams", teamId);
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  const update = {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.nameAr !== undefined ? { nameAr: parsed.data.nameAr } : {}),
    ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    updatedAt: Date.now(),
  };
  const ok = await docUpdate("teams", teamId, update);
  if (!ok) {
    res.status(503).json({ code: "TEAMS_STORAGE_UNAVAILABLE", error: "Teams storage unavailable" });
    return;
  }
  if (parsed.data.active === false) {
    logger.warn({ teamId }, "Team DEACTIVATED by dispatcher");
  }
  invalidateCollectionCache("teams");
  invalidateDocCache("teams", teamId);
  const updated = await docGet("teams", teamId);
  res.json({ ok: true, team: updated });
});

/**
 * DELETE /api/teams/:id/mission — dispatcher force-clears a stuck mission
 * (B3). The only previous escape was resolving the SOS; a mission whose SOS
 * vanished or raced a resolve wedged the team as busy forever. Transactional
 * clear with the same cleared-stays-cleared guard as the SOS path.
 */
router.delete("/:id/mission", requireAdmin, async (req: Request, res: Response) => {
  const teamId = String(req.params.id || "");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(teamId)) {
    res.status(400).json({ error: "Invalid team id" });
    return;
  }
  const team = await docGet("teams", teamId);
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  const result = await clearTeamMissionAtomically(teamId);
  if (result.status === "no-active-mission") {
    res.status(404).json({ code: "NO_ACTIVE_MISSION", error: "No active mission for this team" });
    return;
  }
  if (result.status !== "cleared") {
    res.status(503).json({ code: "TEAMS_STORAGE_UNAVAILABLE", error: "Teams storage unavailable" });
    return;
  }
  invalidateCollectionCache("teamMissions");
  invalidateDocCache("teamMissions", teamId);
  logger.warn({ teamId }, "Team mission force-cleared by dispatcher");
  res.json({ ok: true, mission: result.mission });
});

/**
 * POST /api/teams/:id/block-principal — dispatcher blocks/unblocks a device
 * (its public principal) from re-joining this team (B2). TokenGen revocation
 * kills issued tokens; the blocklist also bars code redemption for that
 * device, closing the lost-device hole. Rejected inside the join transaction.
 */
router.post("/:id/block-principal", requireAdmin, async (req: Request, res: Response) => {
  const teamId = String(req.params.id || "");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(teamId)) {
    res.status(400).json({ error: "Invalid team id" });
    return;
  }
  const parsed = blockPrincipalSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid block fields" });
    return;
  }
  const team = await docGet("teams", teamId);
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  const result = await setPrincipalBlocked(teamId, parsed.data.principal, parsed.data.blocked);
  if (result === "missing") {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  if (result === "unavailable") {
    res.status(503).json({ code: "TEAMS_STORAGE_UNAVAILABLE", error: "Teams storage unavailable" });
    return;
  }
  invalidateCollectionCache("teams");
  invalidateDocCache("teams", teamId);
  if (parsed.data.blocked) {
    logger.warn({ teamId, principal: "[principal]" }, "Principal BLOCKED from team");
  }
  res.json({ ok: true, blocked: parsed.data.blocked, principal: parsed.data.principal });
});

/**
 * DELETE /api/teams/:id/members/:memberId — dispatcher removes (deactivates)
 * a member, e.g. a device lost or a reassignment. B1/B2 hardening:
 *  - tokenGen is BUMPED → every token ever issued to this member dies at the
 *    next gate hit, even the 12h shift token, even after a later rejoin.
 *  - last-known GPS fields are PURGED (retention decision 4) — a removed
 *    device's location history does not outlive its membership.
 *  - optional `blockPrincipal` also bars the device's principal from ever
 *    re-joining via a join code (lost-device case; unblock via
 *    POST /:id/block-principal {blocked:false}).
 * The member doc shell stays as history with active:false.
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
  const blockRequested = req.body?.blockPrincipal === true;
  const principal = typeof member.principal === "string" ? member.principal : "";
  if (blockRequested && !principal) {
    res.status(409).json({ error: "Member has no bound principal to block" });
    return;
  }

  // Order matters: the gen bump FIRST (dead token before anything else can
  // race), then deactivation + GPS purge, then the optional blocklist write.
  const bumped = await incrementDocField("teamMembers", memberId, "tokenGen", 1);
  if (!bumped) {
    res.status(503).json({ code: "TEAMS_STORAGE_UNAVAILABLE", error: "Teams storage unavailable" });
    return;
  }
  await docUpdate("teamMembers", memberId, { active: false, removedAt: Date.now() });
  await docDeleteFields("teamMembers", memberId, ["lastKnownLat", "lastKnownLng", "lastSeenAt"]);
  removeMember(memberId);
  let blockedPrincipal = false;
  if (blockRequested) {
    const blockResult = await setPrincipalBlocked(teamId, principal, true);
    blockedPrincipal = blockResult === "blocked";
  }
  logger.info({ memberId, teamId, blockedPrincipal }, "Team member removed by dispatcher");
  res.json({ ok: true, tokenRevoked: true, gpsPurged: true, blockedPrincipal });
});

export default router;
