import { Request, Response, Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { collectionGet, docSet, docUpdate, docGet } from "../fs.js";
import { requireAdmin } from "../middleware.js";
import { getHaversineDistance } from "../geo.js";
import { getReportsDbResult } from "../db.js";
import config from "../config.js";
import logger from "../logger.js";

const router = Router();

const NA_BOUNDS = { minLat: 19, maxLat: 38, minLng: -18, maxLng: 25 };

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
});

const dispatchSchema = z.object({
  type: z.enum(["protection_civile", "volunteers"]),
  teamNameAr: z.string().min(1),
  teamNameFr: z.string().min(1),
  notes: z.string().optional(),
});

const profileSchema = z.object({
  deviceId: z.string().min(1).max(128),
  name: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
});

const PROFILE_COOKIE = "sos_device_id";

function bindProfileDevice(req: Request, res: Response, deviceId: string): boolean {
  const bound = (req as any).cookies?.[PROFILE_COOKIE];
  if (bound && bound !== deviceId) {
    res.status(403).json({ error: "Device identity mismatch" });
    return false;
  }
  if (!bound) {
    res.cookie(PROFILE_COOKIE, deviceId, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: PROFILE_TTL_MS,
    });
  }
  return true;
}

const memorySos: any[] = [];

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
  keyGenerator: (req: Request) => `sos:${String((req.body as any)?.deviceId || req.ip || "unknown")}`,
  message: { error: "Too many SOS requests. Try again shortly." },
});

const sosDuplicates = new Map<string, number>();
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

function isDuplicateSos(deviceId: string): boolean {
  const now = Date.now();
  const last = sosDuplicates.get(deviceId);
  if (last && now - last < DUPLICATE_WINDOW_MS) return true;
  sosDuplicates.set(deviceId, now);
  if (sosDuplicates.size > 10000) {
    const cutoff = now - DUPLICATE_WINDOW_MS;
    for (const [k, v] of sosDuplicates) if (v < cutoff) sosDuplicates.delete(k);
  }
  return false;
}

// ── Encrypted profile store (AES-256-GCM, key derived from SOS_ENCRYPTION_KEY) ─
const PROFILE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const memoryProfiles = new Map<string, { encrypted: string; expiresAt: number }>();

// Prefer a dedicated SOS_ENCRYPTION_KEY so profiles are not encrypted with the
// JWT secret (which also signs session tokens).
function profileKey(): Buffer {
  return createHash("sha256").update("sos-profile:" + (config.sosEncryptionKey || config.jwtSecret)).digest();
}

function tryDecryptProfile(token: string, key: Buffer): { name?: string; phone?: string } | null {
  try {
    const [ivB64, tagB64, dataB64] = token.split(".");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return JSON.parse(dec.toString("utf8"));
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
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", profileKey(), iv);
  const payload = Buffer.from(JSON.stringify(plain), "utf8");
  const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
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

async function getAllSos(): Promise<any[]> {
  const fromDb = await collectionGet("trappedSos", "timestamp", 100);
  let merged: any[];
  if (fromDb && fromDb.length > 0) {
    const dbIds = new Set(fromDb.map((s: any) => s.id));
    const extra = memorySos.filter((s: any) => !dbIds.has(s.id));
    merged = [...extra, ...fromDb];
  } else {
    merged = memorySos;
  }
  return merged;
}

router.get("/", async (_req: Request, res: Response) => {
  const merged = await getAllSos();
  res.json(merged.map(stripAudio).map(anonymizeSos));
});

router.get("/full", requireAdmin, async (_req: Request, res: Response) => {
  const merged = await getAllSos();
  res.json(merged.map(stripAudio));
});

router.get("/:id", requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
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
  const deviceId = req.params.deviceId || "";
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
  const deviceId = req.params.deviceId || "";
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
  memoryProfiles.set(deviceId, { encrypted: record.encrypted, expiresAt: record.expiresAt });
  if (memoryProfiles.size > 20000) {
    for (const [k, v] of memoryProfiles) if (Date.now() > v.expiresAt) memoryProfiles.delete(k);
  }
  await docSet("sosProfiles", deviceId, record);
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

  // Duplicate protection: one active SOS per device within 5 minutes
  if (isDuplicateSos(data.deviceId)) {
    res.status(409).json({ error: "An SOS from this device was already received recently" });
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
  };

  // Persist PII-safe snapshot to Firestore: strip the raw audio body (kept in memory),
  // keep only metadata so records respect Firestore doc limits.
  const { audioUrl, ...cleanForDb } = newSos;
  const clean = Object.fromEntries(
    Object.entries(cleanForDb).filter(([, v]) => v !== undefined)
  );
  if (newSos.audioUrl) clean.hasAudio = true;
  await docSet("trappedSos", newSos.id, clean);
  memorySos.unshift(newSos);
  if (memorySos.length > MEMORY_SOS_MAX_ITEMS) {
    memorySos.length = MEMORY_SOS_MAX_ITEMS;
  }
  logger.info({ sosId: newSos.id, lat, lng, priority, nearbyFireCorroborated }, "New SOS created");
  res.json(stripAudio(newSos));
});

router.post("/:id/resolve", requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  await docUpdate("trappedSos", id, { status: "resolved" });
  const sos = memorySos.find((s: any) => s.id === id);
  if (sos) sos.status = "resolved";
  res.json({ success: true });
});

router.post("/:id/dispatch", requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = dispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const dispatchItem = {
    type: parsed.data.type,
    teamNameAr: parsed.data.teamNameAr,
    teamNameFr: parsed.data.teamNameFr,
    dispatchedAt: new Date().toISOString(),
    status: "en_route",
    notes: parsed.data.notes || "",
  };

  const sos = memorySos.find((s: any) => s.id === id);
  if (sos) {
    if (!sos.dispatchedTeams) sos.dispatchedTeams = [];
    sos.dispatchedTeams.push(dispatchItem);
  }
  try {
    const existing = await collectionGet("trappedSos");
    const current = existing?.find((d: any) => d.id === id);
    if (current) {
      const teams = current.dispatchedTeams || [];
      await docUpdate("trappedSos", id, { dispatchedTeams: [...teams, dispatchItem] });
    } else if (sos) {
      await docSet("trappedSos", id, sos);
    }
  } catch (err) {
    logger.error({ err, id }, "Firestore dispatch error");
  }
  res.json({ success: true, dispatch: dispatchItem });
});

export default router;
