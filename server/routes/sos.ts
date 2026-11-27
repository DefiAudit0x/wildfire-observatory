import { Request, Response, Router } from "express";
import { z } from "zod";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createHash, randomBytes } from "crypto";
import { encryptAead, decryptAead } from "../crypto.js";
import { collectionGet, createSosWithAdmission, docSet, docGet, appendSosDispatch, resolveSosAtomically } from "../fs.js";
import { isTrustedOrigin, requireAdmin } from "../middleware.js";
import { str } from "../params.js";
import { getHaversineDistance, NA_BOUNDS } from "../geo.js";
import { getReportsDbResult } from "../db.js";
import { isFreshThreatTimestamp } from "./wilayas.js";
import config from "../config.js";
import logger from "../logger.js";

const router = Router();

// ARC-M09: NA_BOUNDS now lives once in server/geo.ts (single canonical copy).

const MAX_AUDIO_BASE64_LENGTH = 700 * 1024; // ~512KB raw audio, fits comfortably in Firestore doc limits
const MAX_AUDIO_DURATION_SEC = 20;

const sosSchema = z.object({
  deviceId: z.string().min(1).max(128),
  // v2.15.0 (audit — no fake coordinates): a device WITHOUT a GPS fix may
  // submit an SOS with null coordinates (Android had been substituting
  // Algiers constants, which silently drove priority/corroboration math).
  // Absent/null coords are honest; if present they must be finite and
  // inside the coverage geofence.
  lat: z.union([z.number(), z.string(), z.null()]).optional(),
  lng: z.union([z.number(), z.string(), z.null()]).optional(),
  hasLocation: z.boolean().optional(),
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
  name: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
});

const memorySos: any[] = [];

// F4: durable idempotency ledger — clientGeneratedId → sosId. Memory-first
// (same window as memorySos), Firestore-backed so a retry after process death
// still replays instead of duplicating.
const SOS_IDEMPOTENCY_COLLECTION = "sosIdempotency";

async function lookupSosByIdempotencyKey(clientGeneratedId: string, fresh = false): Promise<any | null> {
  const mem = memorySos.find((s: any) => s.clientGeneratedId === clientGeneratedId);
  if (mem) return mem;
  const key = await docGet(SOS_IDEMPOTENCY_COLLECTION, clientGeneratedId, fresh);
  const sosId = key?.sosId;
  if (typeof sosId !== "string" || !sosId) return null;
  return await docGet("trappedSos", sosId, fresh);
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
// S-H3 (half of the fix): the raw audio body is memory-ONLY (a restart drops
// it anyway) and its operational value is the first response window, not 12
// hours. Aging audio out after 2h bounds the worst-case audio residency —
// 200 entries × 700KB ≈ 140MB — to roughly one response shift, and caps what
// a flood of attacker SOS entries can pin in RAM. Metadata (id, status,
// priority, coords) still lives the full 12h window for the command views.
const MEMORY_SOS_AUDIO_TTL_MS = 2 * 60 * 60 * 1000;
function sweepMemorySos() {
  const cutoff = Date.now() - MEMORY_SOS_MAX_AGE_MS;
  const audioCutoff = Date.now() - MEMORY_SOS_AUDIO_TTL_MS;
  while (memorySos.length > 0 && new Date(memorySos[memorySos.length - 1].timestamp).getTime() < cutoff) {
    memorySos.pop();
  }
  for (const s of memorySos) {
    if (s.audioUrl && new Date(s.timestamp).getTime() < audioCutoff) {
      s.audioUrl = undefined;
    }
  }
}
sweepMemorySos();
setInterval(sweepMemorySos, 15 * 60 * 1000).unref();

// ── Rate limiting & duplicate detection ──────────────────────────────────────
// S-H3: the per-device window alone was keyed by a request-BODY field, so an
// attacker rotating deviceIds minted a fresh 2-per-minute bucket on every
// request and flooded memorySos (evicting REAL SOS from the 200-item window).
// The fix is layered: an ADDRESS-level limiter in front bounds any single
// source (device rotation still lands in the same IP bucket), while the
// per-device limiter keeps its role of pacing one honest device. Multiple
// trapped victims behind one NAT are still served — the IP budget (10 per
// 2 min) admits them; a flooder cannot exceed it from that address.
const sosIpLimiter = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const ip = req.ip ?? "unknown";
    return `sos-ip:${ip === "unknown" ? ip : ipKeyGenerator(ip)}`;
  },
  message: { error: "Too many SOS requests from this address. Try again shortly." },
});

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
const PROFILE_COOKIE = "sos_profile";

function profileIdForToken(token: string): string {
  return "profile-" + createHash("sha256").update(token).digest("hex");
}

function profileToken(req: Request): string | null {
  const token: unknown = req.cookies?.[PROFILE_COOKIE];
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function requireProfileDevice(req: Request, res: Response): string | null {
  const requested = str(req.params.deviceId);
  if (!requested || requested.length > 128) {
    res.status(400).json({ error: "Invalid deviceId" });
    return null;
  }
  const token = profileToken(req);
  const deviceId = token && profileIdForToken(token);
  if (!deviceId || (requested !== "current" && requested !== deviceId)) {
    res.status(403).json({ error: "Device identity mismatch" });
    return null;
  }
  return deviceId;
}

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
  const { name, phone, audioUrl, dispatchedTeams, deviceId, textMessage, clientGeneratedId, ...rest } = sos;
  return {
    ...rest,
    // Fix 43 (SOS-5): a no-fix SOS persists null coordinates — never
    // fabricate 0,0 for it on the public feed.
    lat: sos.lat == null ? null : Math.round(sos.lat * 100) / 100,
    lng: sos.lng == null ? null : Math.round(sos.lng * 100) / 100,
  };
}

type SosReadSource = "firestore" | "memory_fallback";

// The public + staff feeds cap resolved SOS at the 100 newest: operators
// need every active SOS plus recent history, not an unbounded archive.
const SOS_RESOLVED_CAP = 100;

async function getAllSos(): Promise<{ items: any[]; source: SosReadSource }> {
  // CodeRabbit on PR #213: the old read fetched the ENTIRE trappedSos
  // collection on every cache miss, then kept all non-resolved + the first
  // 100 resolved — with 50k resolved SOS that is 50,001 docs read. Split
  // the read instead: every active SOS (UNCAPPED — a shared limit must
  // never omit an active SOS, F058) + the 100 newest SOS overall, filtered
  // to resolved in memory.
  //
  // SINGLE-FIELD INDEXES ONLY — by design, no composite index: Firestore
  // auto-creates a single-field index for every field, so neither query
  // needs a manual `firebase deploy --only firestore:indexes` and the PR
  // is self-contained. A `where(status == ...)` COMBINED with an
  // `orderBy(timestamp)` would require a (status, timestamp) composite
  // index that no workflow or doc deploys — until someone deployed it by
  // hand, both queries would fail in production and this would fall back
  // to the (empty-when-healthy) memory list, hiding every SOS on a
  // safety-critical surface. So: the filtered query has NO orderBy (its
  // rows are sorted in memory below), and the ordered query has NO where
  // filter (resolved is filtered in memory below). Either query alone is
  // served by a single-field index.
  //
  // Consequence, accepted: the resolved history shown may be fewer than
  // 100 when active SOS occupy slots in the newest-100 window — the cap
  // is a maximum, not a guarantee. TrappedSOS status is only "active" |
  // "resolved" (src/types.ts), so == "active" covers every non-resolved
  // document.
  const active = await collectionGet("trappedSos", undefined, undefined, false, { field: "status", op: "==", value: "active" });
  if (active === null) return { items: memorySos, source: "memory_fallback" };
  const newest = await collectionGet("trappedSos", "timestamp", SOS_RESOLVED_CAP, false);
  // CodeRabbit on PR #213: when only the history read fails, the active
  // read already succeeded — discarding it hid every active SOS (after a
  // restart memorySos can be empty, so both feeds answered an empty list
  // with HTTP 200). Return the active result merged with available memory
  // records instead; the source stays "memory_fallback" because the
  // resolved history is missing and the list is incomplete.
  const resolved = newest === null ? [] : newest.filter((s: any) => s.status === "resolved");

  // CodeRabbit on PR #213: the two reads are not one snapshot — a resolve
  // landing between them returns the same SOS in both lists (active
  // version + resolved version), and [...active, ...resolved] kept both.
  // Dedup by id with the later (resolved) version winning.
  const byId = new Map<string, any>();
  for (const s of [...active, ...resolved]) byId.set(s.id, s);
  const fromDb = [...byId.values()];
  let merged: any[];
  if (fromDb.length > 0) {
    const dbIds = new Set(fromDb.map((s: any) => s.id));
    const extra = memorySos.filter((s: any) => !dbIds.has(s.id));
    merged = [...extra, ...fromDb];
  } else {
    merged = [...memorySos];
  }
  let resolvedCount = 0;
  merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return { items: merged.filter((s) => s.status !== "resolved" || ++resolvedCount <= SOS_RESOLVED_CAP), source: newest === null ? "memory_fallback" : "firestore" };
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
  const deviceId = requireProfileDevice(req, res);
  if (!deviceId) return;
  res.setHeader("Cache-Control", "no-store");
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

async function saveProfile(req: Request, res: Response, deviceId: string, token?: string) {
  const parsed = profileSchema.safeParse(req.body);
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
  if (token) {
    res.cookie(PROFILE_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/api/sos/profile",
      maxAge: PROFILE_TTL_MS,
    });
  }
  res.json({ success: true });
}

router.put("/profile/:deviceId", async (req: Request, res: Response) => {
  const deviceId = requireProfileDevice(req, res);
  if (deviceId) await saveProfile(req, res, deviceId, profileToken(req) ?? undefined);
});

// A fresh browser can only create a new profile under a server-generated
// credential. Guessing a profile ID never gives access to its credential.
// Fix 2b (CodeRabbit, CWE-352): enrollment ISSUES the sos_profile credential
// cookie, so it must pass the origin check even with no cookie present — the
// global csrfProtection skips cookieless requests, and SameSite=lax does not
// stop a cross-site top-level form POST response from replacing the victim's
// cookie with the attacker's rescue contact.
router.post("/profile", async (req: Request, res: Response) => {
  if (!isTrustedOrigin(req)) return void res.status(403).json({ error: "Forbidden: cross-origin state change rejected" });
  const token = profileToken(req) ?? randomBytes(32).toString("hex");
  await saveProfile(req, res, profileIdForToken(token), token);
});

router.post("/", sosIpLimiter, sosPostLimiter, async (req: Request, res: Response) => {
  const parsed = sosSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields", details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  // v2.15.0: honest no-fix SOS — null coordinates skip the geofence and the
  // proximity/priority derivation entirely (they were computed from nothing).
  const hasLocation = data.hasLocation === true || (data.lat != null && data.lng != null);
  const lat = hasLocation ? Number(data.lat) : Number.NaN;
  const lng = hasLocation ? Number(data.lng) : Number.NaN;

  // Geofence: only accept SOS within monitoring coverage (North Africa)
  if (hasLocation &&
      (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < NA_BOUNDS.minLat || lat > NA_BOUNDS.maxLat ||
      lng < NA_BOUNDS.minLng || lng > NA_BOUNDS.maxLng)) {
    res.status(400).json({ error: "Location is outside the monitoring coverage area" });
    return;
  }

  // v2.15.0: NaN can never persist — a non-numeric audioDuration is a 400,
  // while the pinned numeric clamp (999 → ≤20s) is kept.
  if (data.audioDuration != null && !Number.isFinite(Number(data.audioDuration))) {
    res.status(400).json({ error: "Invalid audioDuration" });
    return;
  }

  // F4: a retried submission (same clientGeneratedId) replays the FIRST
  // stored SOS — checked before context and admission, so a retry after the
  // 5-minute deviceId dedup window still returns the original, never a dupe.
  if (data.clientGeneratedId) {
    try {
      const replay = await lookupSosByIdempotencyKey(data.clientGeneratedId);
      if (replay) {
        if (replay.deviceId !== data.deviceId) {
          res.status(409).json({ error: "SOS retry key belongs to a different device" });
          return;
        }
        logger.info({ sosId: replay.id }, "SOS replayed by clientGeneratedId");
        res.json({ id: replay.id, status: replay.status });
        return;
      }
    } catch (err) {
      // Ledger lookup failure must NEVER block an emergency call — fall
      // through to admission (worst case: the old duplicate behavior).
      logger.error({ err }, "SOS idempotency lookup failed; admitting without replay");
    }
  }

  // Context: nearest active fire (non-blocking — never prevent an SOS).
  // IMPORTANT: proximity to a fire corroborates the caller's claim; it is NOT
  // verification that the person is actually trapped. The field is named
  // accordingly (`nearbyFireCorroborated`) on purpose.
  let nearestFireDistanceKm: number | null = null;
  let nearbyFireCorroborated = false;
  let priority: string = "unknown";
  if (hasLocation) {
    let contextTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const dbResult = await Promise.race([
        getReportsDbResult(),
        new Promise<never>((_, reject) => {
          contextTimeout = setTimeout(() => reject(new Error("SOS proximity context timed out")), 3000);
        }),
      ]);
      const active = dbResult.status === "ok" ? dbResult.reports.filter(
        (r: any) => r.status !== "resolved" && r.status !== "rejected" && isFreshThreatTimestamp(r.timestamp)
      ) : [];
      if (active.length > 0) {
        nearestFireDistanceKm = active.reduce((min: number, fire: any) => {
          const d = getHaversineDistance(lat, lng, fire.lat, fire.lng);
          return Math.min(min, d);
        }, Infinity);
        nearbyFireCorroborated = nearestFireDistanceKm !== Infinity && (nearestFireDistanceKm ?? Infinity) <= 10;
      }
    } catch (err) {
      logger.warn({ err }, "SOS proximity context unavailable; proceeding without context");
    } finally {
      clearTimeout(contextTimeout);
    }
    if (nearestFireDistanceKm !== null && Number.isFinite(nearestFireDistanceKm)) {
      priority =
        nearestFireDistanceKm <= 2 ? "critical"
        : nearestFireDistanceKm <= 5 ? "high"
        : nearestFireDistanceKm <= 10 ? "medium"
        : "low";
    }
  }

  const audioDuration = data.audioDuration != null
    ? Math.min(Math.max(Number(data.audioDuration), 1), MAX_AUDIO_DURATION_SEC)
    : undefined;

  const newSos: any = {
    id: `sos-${Date.now()}-${randomBytes(3).toString("hex")}`,
    deviceId: data.deviceId,
    lat: hasLocation ? lat : null,
    lng: hasLocation ? lng : null,
    hasLocation,
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
  const admission = await createSosWithAdmission(newSos.id, clean, admissionId, acceptedAt, DUPLICATE_WINDOW_MS,
    data.clientGeneratedId
      ? {
          collection: SOS_IDEMPOTENCY_COLLECTION,
          key: data.clientGeneratedId,
          record: {
            sosId: newSos.id,
            deviceId: data.deviceId,
            createdAt: newSos.timestamp,
          },
        }
      : undefined
  );
  if (admission === "duplicate") {
    // A concurrent same-key submission may have committed after the early lookup.
    if (data.clientGeneratedId) {
      try {
        const replay = await lookupSosByIdempotencyKey(data.clientGeneratedId, true);
        if (replay) {
          if (replay.deviceId !== data.deviceId) {
            res.status(409).json({ error: "SOS retry key belongs to a different device" });
            return;
          }
          logger.info({ sosId: replay.id }, "SOS replayed by clientGeneratedId");
          res.json({ id: replay.id, status: replay.status });
          return;
        }
      } catch (err) {
        logger.error({ err }, "SOS idempotency lookup failed; returning duplicate");
      }
    }
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
  // Emergency coordinates belong in the private SOS record, not operational
  // logs that may be copied to a broader log aggregation system.
  logger.info({ sosId: newSos.id, hasLocation, priority, nearbyFireCorroborated }, "New SOS created");
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
  if (outcome === "already_dispatched") {
    // Fix 43 (SOS-6): the durable log already holds this dispatch — do not
    // append a duplicate to the memory fallback.
    // Fix 43b (CodeRabbit 6039588272): return the STORED dispatch, newest
    // first. The memory list accumulates one entry per dispatch (clear +
    // re-dispatch appends a second entry for the same team), so .find()
    // would return the superseded one. When the process restarted and
    // memorySos lacks the SOS, read the durable trappedSos doc instead of
    // returning the freshly built item — its dispatchedAt/notes describe a
    // write that never happened. The fresh item is only a last-resort
    // fallback when no stored entry exists anywhere.
    const sos = memorySos.find((s: any) => s.id === id);
    let existing = [...(sos?.dispatchedTeams ?? [])].reverse().find((t: any) => t.teamId === missionTeamId);
    if (!existing) {
      try {
        const stored: any = await docGet("trappedSos", id);
        const storedTeams = Array.isArray(stored?.dispatchedTeams) ? stored.dispatchedTeams : [];
        existing = [...storedTeams].reverse().find((t: any) => t.teamId === missionTeamId);
      } catch {
        // Durable read failed — fall through to the freshly built item.
      }
    }
    res.json({ success: true, dispatch: existing ?? dispatchItem, alreadyDispatched: true });
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
