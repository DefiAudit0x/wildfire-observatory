import { createHash, timingSafeEqual } from "crypto";
import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import config from "../config.js";
import { collectionGet } from "../fs.js";
import { verifyAdminPassword } from "./admin.js";
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
  deviceId: z.string().min(1),
  lat: z.union([z.number(), z.string()]),
  lng: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  badgeCode: z.string().optional(),
});

function safePasswordMatch(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

async function checkSuperAdminPassword(candidate: string): Promise<boolean> {
  if (config.superAdminPassword && safePasswordMatch(candidate, config.superAdminPassword)) return true;
  return verifyAdminPassword(candidate);
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
      const match = badges?.find((b: any) => b.code === badgeCode && b.isActive);
      if (match) {
        finalName = match.ownerName;
        finalRole = match.type;
      }
    } catch (err) {
      // ignore badge matching errors, fall back to provided name/role
    }
  }

  activeUserLocations.set(deviceId, {
    lat: Number(lat),
    lng: Number(lng),
    name: finalName,
    role: finalRole,
    lastSeen: Date.now(),
  });
  res.json({ success: true, name: finalName, role: finalRole });
});

router.post("/auth/central-command", async (req: Request, res: Response) => {
  const { password } = req.body;
  if (!password || !(await checkSuperAdminPassword(password))) {
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
