import { Request, Response, Router } from "express";
import { z } from "zod";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createHash, randomBytes } from "crypto";
import { encryptAead, decryptAead } from "../crypto.js";
import { collectionGet, createSosWithAdmission, docSet, docGet, appendSosDispatch, resolveSosAtomically } from "../fs.js";
import { requireAdmin } from "../middleware.js";
import { str } from "../params.js";
import { getHaversineDistance, NA_BOUNDS } from "../geo.js";
import { getReportsDbResult } from "../db.js";
import config from "../config.js";
import logger from "../logger.js";
import { issueDeviceCookie, ownsDevice } from "../deviceBinding.js";

const router = Router();

// ARC-M09: NA_BOUNDS now lives once in server/geo.ts (single canonical copy).

const MAX_AUDIO_BASE64_LENGTH = 700 * 1024; // ~512KB raw audio, fits comfortably in Firestore doc limits
const MAX_AUDIO_DURATION_SEC = 20;

const sosSchema = z.object({
  deviceId: z.string().min(1).max(128),
  lat: z.union([z.number(), z.string()]),
  lng: z.union([z.number(), z.string()]),
  name: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
  audioUrl: z.string().max(MAX_AUDIO_BASE64_LENGTH).optional(),
  audioDuration: z.union([z.number(), z.string()]).optional(),
  textMessage: z.string().max(500).optional(),
  // F4 fix: idempotency key — reports carried one since v1, SOS did not, so a
  // 5xx-timeout retry (the Android queue replays up to 8 attempts) created
  // duplicate SOS calls. Same contract as reports: same key + same logical
  // SOS ⇒ the FIRST stored SOS is replayed, never a duplicate.
  clientGeneratedId: z.string().min(8).max(64).optional(),
});

const dispatchSchema = z.object({
  // v2.3.0 (simulation purge): dispatch targets a REGISTERED team by its
  // server identity. The old legacy path (free-text type/teamNameAr/teamNameFr)
  // let an operator "dispatch" phantom teams that never existed — it died with
  // the simulated dispatch table. The team entity supplies names/type.
  teamId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
  // S-M7: notes rode unbounded into every dispatchedTeams entry
  // (Firestore arrayUnion) — an operator paste (or a hostile admin client)
  // grew the trappedSos doc toward its size limit and inflated every later
  // read of the SOS. Match the citizen textMessage cap.
  notes: z.string().max(500, "Notes must be 500 characters or fewer").optional(),
});

const profileSchema = z.object({
  deviceId: z.string().min(1).max(128),
  name: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
});

// M2 fix: ownership is cryptographic — a server-signed cookie — not
// first-come. A valid signed cookie for the claimed device grants access;
// an existing signed cookie for a DIFFERENT device is a 403; no cookie
// issues one for the claimed device. (Legacy plain "sos_device_id" cookies
// are simply ignored — affected clients rebind once.)
function bindProfileDevice(req: Request, res: Response, deviceId: string): boolean {
  if (ownsDevice(req, deviceId)) return true;
  const bound = (req as any).cookies?.["device_sig"];
  if (bound) {
    res.status(403).json({ error: "Device identity mismatch. Clear site data (cookies) to bind a different device." });
    return false;
  }
  issueDeviceCookie(res, deviceId, PROFILE_TTL_MS);
  return true;
}

const memorySos: any[] = [];

// F4: durable idempotency ledger — clientGeneratedId → sosId. Memory-first
// (same window as memorySos), Firestore-backed so a retry after process death
// still replays instead of duplicating.
const SOS_IDEMPOTENCY_COLLECTION = "sosIdempotency";

async function lookupSosByIdempotencyKey(clientGeneratedId: string): Promise<any | null> {
  const mem = memorySos.find((s: any) => s.clientGeneratedId === clientGeneratedId);
  if (mem) return mem;
  const key = await docGet(SOS_IDEMPOTENCY_COLLECTION, clientGeneratedId);
  const sosId = key?.sosId;
  if (typeof sosId !== "string" || !sosId) return null;
  return await docGet("trappedSos", sosId);
}

export interface SosSummary {
  id: string;
  timestamp: string;
  status: string;
  priority: string;
}

/** Metadata-only snapshot of in-memory SOS (no audio bodies) for analytics. */
export function getSosSummarySnapshot(): SosSummary[] {
  return memorySos.map((s) => ({
    id: s.id,
    timestamp: s.timestamp,
    status: s.status,
    priority: s.priority,
  }));
}

// Background sweep: cap in-memory SOS (raw base64 audio held here only) to a
// rolling window so long-running processes don't accumulate unbounded memory.
const MEMORY_SOS_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MEMORY_SOS_MAX_ITEMS = 200;
function sweepMemorySos() {
  const cutoff = Date.now() - MEMORY_SOS_MAX_AGE_MS;
  while (memorySos.length > 0 && new Date(memorySos[memorySos.length - 1].timestamp).getTime() < cutoff) {
    memorySos.pop();
  }
}
sweepMemorySos();
setInterval(sweepMemorySos, 15 * 60 * 1000).unref();

// ── Rate limiting & duplicate detection ──────────────────────────────────────
const sosPostLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const deviceId = (req.body as any)?.deviceId;
    if (deviceId) return `sos:${String(deviceId)}`;
    const ip = req.ip ?? "unknown";
    return `sos:${ip === "unknown" ? ip : ipKeyGenerator(ip)}`;
  },
  message: { error: "Too many SOS requests. Try again shortly." },
});

const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

// ── Encrypted profile store (AES-256-GCM, key derived from SOS_ENCRYPTION_KEY) ─
const PROFILE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const memoryProfiles = new Map<string, { encrypted: string; expiresAt: number }>();

// Prefer a dedicated SOS_ENCRYPTION_KEY so profiles are not encrypted with the
// JWT secret (which also signs session tokens).
function profileKey(): Buffer {
  return createHash("sha256").update("sos-profile:" + (config.sosEncryptionKey || config.jwtSecret)).digest();
}

// ARC-M09: the GCM envelope is shared (server/crypto.ts); the key domains
// ("sos-profile" primary + legacy JWT-derived fallback below) stay local.
function tryDecryptProfile(token: string, key: Buffer): { name?: string; phone?: string } | null {
  const plain = decryptAead(token, key);
  if (plain === null) return null;
  try {
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}

// Legacy fallback: decrypt records still carrying the old JWT-derived key.
function decryptProfile(token: string): { name?: string; phone?: string } | null {
  const primary = tryDecryptProfile(token, profileKey());
  if (primary !== null) return primary;
  if (config.sosEncryptionKey) {
    const legacy = createHash("sha256").update("sos-profile:" + config.jwtSecret).digest();
    return tryDecryptProfile(token, legacy);
  }
  return null;
}

function encryptProfile(plain: { name?: string; phone?: string }): string {
  return encryptAead(JSON.stringify(plain), profileKey());
}

function stripAudio(sos: any) {
  if (!sos) return sos;
  const hasAudio = Boolean(sos.audioUrl);
  const { audioUrl, ...rest } = sos;
  return hasAudio ? { ...rest, hasAudio, audioSizeBytes: sos.audioUrl ? Math.round((sos.audioUrl.length * 3) / 4) : 0 } : sos;
}

function anonymizeSos(sos: any) {
  if (!sos) return sos;
  const { name, phone, audioUrl, dispatchedTeams, deviceId, ...rest } = sos;
  return {
    ...rest,
    lat: Math.round(sos.lat * 100) / 100,
    lng: Math.round(sos.lng * 100) / 100,
  };
}

type SosReadSource = "firestore" | "memory_fallback";

async function getAllSos(): Promise<{ items: any[]; source: SosReadSource }> {
  const fromDb = await collectionGet("trappedSos", "timestamp", 100);
  if (fromDb === null) return { items: memorySos, source: "memory_fallback" };

  let merged: any[];
  if (fromDb.length > 0) {
    const dbIds = new Set(fromDb.map((s: any) => s.id));
    const extra = memorySos.filter((s: any) => !dbIds.has(s.id));
    merged = [...extra, ...fromDb];
  } else {
    merged = memorySos;
  }
  return { items: merged, source: "firestore" };
}

router.get("/", async (_req: Request, res: Response) => {
  const { items, source } = await getAllSos();
  res.setHeader("X-SOS-Source", source);
  res.json(items.map(stripAudio).map(anonymizeSos));
});

router.get("/full", requireAdmin, async (_req: Request, res: Response) => {
  const { items, source } = await getAllSos();
  res.setHeader("X-SOS-Source", source);
  res.json(items.map(stripAudio));
});

router.get("/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = str(req.params.id);
  const memory = memorySos.find((s: any) => s.id === id);
  if (memory) {
    res.json(memory);
    return;
  }
  const doc = await docGet("trappedSos", id);
  if (!doc) {
    res.status(404).json({ error: "SOS not found" });
    return;
  }
  res.json(doc);
});

// ── Developer-friendly profile endpoints (server-side encrypted identity) ────
router.get("/profile/:deviceId", async (req: Request, res: Response) => {
  const deviceId = str(req.params.deviceId) || "";
  if (!deviceId || deviceId.length > 128) {
    res.status(400).json({ error: "Invalid deviceId" });
    return;
  }
  if (!bindProfileDevice(req, res, deviceId)) return;
  const mem = memoryProfiles.get(deviceId);
  let profile: { name?: string; phone?: string } | null = null;
  if (mem && Date.now() < mem.expiresAt) {
    profile = decryptProfile(mem.encrypted);
  } else {
    const doc = await docGet("sosProfiles", deviceId);
    if (doc && doc.encrypted && doc.expiresAt && Date.now() < doc.expiresAt) {
      profile = decryptProfile(doc.encrypted);
    }
  }
  res.json({ name: profile?.name || "", phone: profile?.phone || "" });
});

router.put("/profile/:deviceId", async (req: Request, res: Response) => {
  const deviceId = str(req.params.deviceId) || "";
  if (!deviceId || deviceId.length > 128) {
    res.status(400).json({ error: "Invalid deviceId" });
    return;
  }
  if (!bindProfileDevice(req, res, deviceId)) return;
  const parsed = profileSchema.safeParse({ deviceId, ...req.body });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid profile data" });
    return;
  }
  const profile = {
    name: (parsed.data.name || "").trim(),
    phone: (parsed.data.phone || "").trim(),
  };
  const record = {
    encrypted: encryptProfile(profile),
    expiresAt: Date.now() + PROFILE_TTL_MS,
    updatedAt: new Date().toISOString(),
    deviceId,
  };
  const persisted = await docSet("sosProfiles", deviceId, record);
  if (!persisted) {
    res.status(503).json({ error: "Profile storage unavailable" });
    return;
  }
  memoryProfiles.set(deviceId, { encrypted: record.encrypted, expiresAt: record.expiresAt });
  if (memoryProfiles.size > 20000) {
    for (const [k, v] of memoryProfiles) if (Date.now() > v.expiresAt) memoryProfiles.delete(k);
  }
  res.json({ success: true });
});

router.post("/", sosPostLimiter, async (req: Request, res: Response) => {
  const parsed = sosSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields", details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  const lat = Number(data.lat);
  const lng = Number(data.lng);

  // Geofence: only accept SOS within monitoring coverage (North Africa)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < NA_BOUNDS.minLat || lat > NA_BOUNDS.maxLat ||
      lng < NA_BOUNDS.minLng || lng > NA_BOUNDS.maxLng) {
    res.status(400).json({ error: "Location is outside the monitoring coverage area" });
    return;
  }

  // Context: nearest active fire (non-blocking — never prevent an SOS).
  // IMPORTANT: proximity to a fire corroborates the caller's claim; it is NOT
  // verification that the person is actually trapped. The field is named
  // accordingly (`nearbyFireCorroborated`) on purpose.
  let nearestFireDistanceKm: number | null = null;
  let nearbyFireCorroborated = false;
  let priority: string = "unknown";
  try {
    const dbResult = await getReportsDbResult();
    const active = dbResult.status === "ok" ? dbResult.reports.filter(
      (r: any) => r.status !== "resolved" && r.status !== "rejected"
    ) : [];
    if (active.length > 0) {
      nearestFireDistanceKm = active.reduce((min: number, fire: any) => {
        const d = getHaversineDistance(lat, lng, fire.lat, fire.lng);
        return Math.min(min, d);
      }, Infinity);
      nearbyFireCorroborated = nearestFireDistanceKm !== Infinity && (nearestFireDistanceKm ?? Infinity) <= 10;
    }
  } catch (err) {
    logger.error({ err }, "SOS proximity check error");
  }
  if (nearestFireDistanceKm !== null && Number.isFinite(nearestFireDistanceKm)) {
    priority =
      nearestFireDistanceKm <= 2 ? "critical"
      : nearestFireDistanceKm <= 5 ? "high"
      : nearestFireDistanceKm <= 10 ? "medium"
      : "low";
  }

  const audioDuration = data.audioDuration != null
    ? Math.min(Math.max(Number(data.audioDuration), 1), MAX_AUDIO_DURATION_SEC)
    : undefined;

  // F4: a retried submission (same clientGeneratedId) replays the FIRST
  // stored SOS — checked before the admission window, so a retry after the
  // 5-minute deviceId dedup window still returns the original, never a dupe.
  if (data.clientGeneratedId) {
    try {
      const replay = await lookupSosByIdempotencyKey(data.clientGeneratedId);
      if (replay) {
        logger.info({ sosId: replay.id }, "SOS replayed by clientGeneratedId");
        res.json(stripAudio(replay));
        return;
      }
    } catch (err) {
      // Ledger lookup failure must NEVER block an emergency call — fall
      // through to admission (worst case: the old duplicate behavior).
      logger.error({ err }, "SOS idempotency lookup failed; admitting without replay");
    }
  }

  const newSos: any = {
    id: `sos-${Date.now()}-${randomBytes(3).toString("hex")}`,
    deviceId: data.deviceId,
    lat,
    lng,
    name: data.name || "شخص محاصر",
    phone: data.phone || "",
    audioUrl: data.audioUrl || undefined,
    audioDuration,
    textMessage: data.textMessage || undefined,
    status: "active",
    timestamp: new Date().toISOString(),
    nearestFireDistanceKm: nearestFireDistanceKm !== null && Number.isFinite(nearestFireDistanceKm)
      ? Math.round(nearestFireDistanceKm * 100) / 100
      : null,
    nearbyFireCorroborated,
    priority,
    clientGeneratedId: data.clientGeneratedId || undefined,
  };

  // Persist PII-safe snapshot to Firestore: strip the raw audio body (kept in memory),
  // keep only metadata so records respect Firestore doc limits.
  const { audioUrl, ...cleanForDb } = newSos;
  const clean = Object.fromEntries(
    Object.entries(cleanForDb).filter(([, v]) => v !== undefined)
  );
  if (newSos.audioUrl) clean.hasAudio = true;
  const acceptedAt = Date.now();
  const admissionId = createHash("sha256").update(data.deviceId).digest("hex");
  const admission = await createSosWithAdmission(newSos.id, clean, admissionId, acceptedAt, DUPLICATE_WINDOW_MS);
  if (admission === "duplicate") {
    res.status(409).json({ error: "An SOS from this device was already received recently" });
    return;
  }
  if (admission !== "created") {
    res.status(503).json({ code: "SOS_STORAGE_UNAVAILABLE", error: "SOS storage unavailable" });
    return;
  }
  memorySos.unshift(newSos);
  if (memorySos.length > MEMORY_SOS_MAX_ITEMS) {
    memorySos.length = MEMORY_SOS_MAX_ITEMS;
  }
  if (data.clientGeneratedId) {
    const keyStored = await docSet(SOS_IDEMPOTENCY_COLLECTION, data.clientGeneratedId, {
      sosId: newSos.id,
      deviceId: data.deviceId,
      createdAt: newSos.timestamp,
    });
    if (!keyStored) {
      // The SOS itself is durably admitted; only the replay ledger write
      // failed. Log loudly — in-memory replay still covers this process.
      logger.warn({ sosId: newSos.id }, "SOS idempotency key persistence failed");
    }
  }
  logger.info({ sosId: newSos.id, lat, lng, priority, nearbyFireCorroborated }, "New SOS created");
  res.json(stripAudio(newSos));
});

router.post("/:id/resolve", requireAdmin, async (req: Request, res: Response) => {
  const id = str(req.params.id);
  // B4: resolve is now ONE transaction — the status flip and the team-mission
  // clear read/write together, so a dispatch racing the resolve can no longer
  // orphan an active mission on a resolved SOS (team busy forever). The
  // cleared count is surfaced and a zero-clear resolve is logged loudly:
  // that used to be a silent `.catch(() => false)`.
  const outcome = await resolveSosAtomically(id);
  if (outcome.status === "missing") {
    res.status(404).json({ error: "SOS not found" });
    return;
  }
  if (outcome.status !== "resolved") {
    res.status(503).json({ code: "SOS_STORAGE_UNAVAILABLE", error: "SOS storage unavailable" });
    return;
  }
  if (outcome.missionsCleared === 0) {
    logger.warn({ sosId: id }, "SOS resolved but cleared ZERO team missions — verify no team is stuck busy");
  } else {
    logger.info({ sosId: id, missionsCleared: outcome.missionsCleared }, "SOS resolved, team missions cleared");
  }
  const sos = memorySos.find((s: any) => s.id === id);
  if (sos) sos.status = "resolved";
  res.json({ success: true, missionsCleared: outcome.missionsCleared });
});

router.post("/:id/dispatch", requireAdmin, async (req: Request, res: Response) => {
  const id = str(req.params.id);
  const parsed = dispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  // Team Mode: dispatching a REGISTERED team. The team entity is the
  // source of truth for names/type, and the mission lock doc id is the teamId
  // itself — the same doc the team's heartbeat responses read back.
  let dispatchItem: Record<string, any>;
  let missionTeamId: string;
  {
    const team = await docGet("teams", parsed.data.teamId);
    if (!team || team.active === false) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    dispatchItem = {
      teamId: team.teamId || parsed.data.teamId,
      type: team.type,
      teamNameAr: team.nameAr,
      teamNameFr: team.name,
      dispatchedAt: new Date().toISOString(),
      status: "en_route",
      notes: parsed.data.notes || "",
    };
    missionTeamId = dispatchItem.teamId;
  }

  let outcome: Awaited<ReturnType<typeof appendSosDispatch>>;
  try {
    outcome = await appendSosDispatch(id, dispatchItem, missionTeamId);
  } catch (err) {
    logger.error({ err, id }, "Firestore dispatch error");
    outcome = "unavailable";
  }

  if (outcome === "missing") {
    res.status(404).json({ error: "SOS not found" });
    return;
  }
  if (outcome === "resolved") {
    res.status(409).json({ error: "This SOS is already resolved" });
    return;
  }
  if (outcome === "team_busy") {
    res.status(409).json({ code: "TEAM_ALREADY_DISPATCHED", error: "This team is already dispatched to an active SOS" });
    return;
  }
  if (outcome !== "ok") {
    res.status(503).json({ code: "SOS_STORAGE_UNAVAILABLE", error: "SOS storage unavailable" });
    return;
  }

  const sos = memorySos.find((s: any) => s.id === id);
  if (sos) {
    if (!sos.dispatchedTeams) sos.dispatchedTeams = [];
    sos.dispatchedTeams.push(dispatchItem);
  }
  res.json({ success: true, dispatch: dispatchItem });
});

export default router;
