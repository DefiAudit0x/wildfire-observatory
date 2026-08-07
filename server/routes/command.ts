import { createHash, timingSafeEqual } from "crypto";
import { Request, Response, Router } from "express";
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

router.post("/location/heartbeat", async (req: Request, res: Response) => {
  const parsed = heartbeatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const { deviceId, lat, lng, name, badgeCode } = parsed.data;
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
