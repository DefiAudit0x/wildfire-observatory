import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import config from "../config.js";
import logger from "../logger.js";
import { collectionGet } from "../fs.js";
import { verifySuperAdminPassword } from "./admin.js";
import { generateAdminToken, requireAdmin } from "../middleware.js";

const router = Router();

const activeUserLocations = new Map<string, { lat: number; lng: number; name: string; role: string; lastSeen: number }>();

const LOCATION_TTL_MS = 5 * 60 * 1000;
const locationCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [deviceId, data] of activeUserLocations) {
    if (now - data.lastSeen > LOCATION_TTL_MS) activeUserLocations.delete(deviceId);
  }
}, LOCATION_TTL_MS);
locationCleanupTimer.unref();

// Heartbeat hardening: no session exists for volunteer tracking, so bound abuse:
//  - per-IP request cap
//  - minimum interval per deviceId (prevents flooding one device's location)
//  - max distinct badge codes per IP per minute (prevents badge-identity spraying)
const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many location heartbeats from this address." },
});

const HEARTBEAT_DEVICE_MIN_MS = 3000;
const heartbeatDeviceTimes = new Map<string, number>();
const HEARTBEAT_MAX_BADGES_PER_IP = 5;
const heartbeatBadgesPerIp = new Map<string, Map<string, number>>();

function pruneHeartbeatMaps() {
  const now = Date.now();
  for (const [deviceId, last] of heartbeatDeviceTimes) {
    if (now - last > 60 * 1000) heartbeatDeviceTimes.delete(deviceId);
  }
  for (const [ip, codes] of heartbeatBadgesPerIp) {
    for (const [code, ts] of codes) {
      if (now - ts > 60 * 1000) codes.delete(code);
    }
    if (codes.size === 0) heartbeatBadgesPerIp.delete(ip);
  }
}
const heartbeatCleanupTimer = setInterval(pruneHeartbeatMaps, 60 * 1000);
heartbeatCleanupTimer.unref();

const heartbeatSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  name: z.string().trim().max(120).optional(),
  badgeCode: z.string().trim().max(64).optional(),
});

// H2 fix: the highest-privilege login gate must not be the cheapest to
// brute-force. Mirror the /api/admin/verify policy (5 attempts / 15 min,
// successful logins not counted) instead of falling back to the general
// 100-per-minute limiter.
const centralCommandLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Too many attempts. Try again in 15 minutes." },
});

async function checkSuperAdminPassword(candidate: string): Promise<boolean> {
  return verifySuperAdminPassword(candidate);
}

router.post("/location/heartbeat", heartbeatLimiter, async (req: Request, res: Response) => {
  const parsed = heartbeatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const { deviceId, lat, lng, name, badgeCode } = parsed.data;

  const now = Date.now();
  const lastSeen = heartbeatDeviceTimes.get(deviceId);
  if (lastSeen && now - lastSeen < HEARTBEAT_DEVICE_MIN_MS) {
    res.status(429).json({ error: "Heartbeat too frequent for this device." });
    return;
  }
  heartbeatDeviceTimes.set(deviceId, now);

  if (badgeCode) {
    const ip = req.ip || "unknown";
    let codes = heartbeatBadgesPerIp.get(ip);
    if (!codes) {
      codes = new Map<string, number>();
      heartbeatBadgesPerIp.set(ip, codes);
    }
    const seenAt = codes.get(badgeCode);
    if (!seenAt) {
      codes.set(badgeCode, now);
      for (const [code, ts] of codes) {
        if (now - ts > 60 * 1000) codes.delete(code);
      }
      if (codes.size > HEARTBEAT_MAX_BADGES_PER_IP) {
        res.status(429).json({ error: "Too many badge codes from this address." });
        return;
      }
    }
  }

  let finalName = name || "غير معروف";
  let finalRole = "citizen";

  if (badgeCode) {
    try {
      const badges = await collectionGet("badgeCodes");
      const match = badges?.find((b: any) => {
        if (b.code !== badgeCode || b.isActive !== true) return false;
        if (b.expiresAt) {
          const expiry = typeof b.expiresAt === "number" ? b.expiresAt : Date.parse(b.expiresAt);
          if (Number.isFinite(expiry) && now >= expiry) return false;
        }
        return true;
      });
      if (match) {
        finalName = match.ownerName;
        finalRole = match.type === "official" || match.type === "volunteer" ? match.type : "citizen";
      }
    } catch (err) {
      // ignore badge matching errors, fall back to provided name/role
    }
  }

  activeUserLocations.set(deviceId, {
    lat,
    lng,
    name: finalName,
    role: finalRole,
    lastSeen: Date.now(),
  });
  res.json({ success: true, name: finalName, role: finalRole });
});

router.post("/auth/central-command", centralCommandLimiter, async (req: Request, res: Response) => {
  const { password } = req.body;
  if (!password || !(await checkSuperAdminPassword(password))) {
    // H2 fix: log brute-force probes so monitoring can flag them early.
    logger.warn({ ip: req.ip }, "Central-command auth failed");
    res.status(401).json({ valid: false });
    return;
  }
  const token = generateAdminToken();
  res.cookie("admin_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ valid: true });
});

router.get("/locations", requireAdmin, async (_req: Request, res: Response) => {
  const now = Date.now();
  activeUserLocations.forEach((val, key) => {
    if (now - val.lastSeen > LOCATION_TTL_MS) activeUserLocations.delete(key);
  });
  const users = Array.from(activeUserLocations.entries()).map(([deviceId, data]) => ({
    deviceId,
    ...data,
    lastSeen: new Date(data.lastSeen).toISOString(),
  }));
  res.json(users);
});

export default router;
