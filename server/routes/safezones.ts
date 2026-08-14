import { Request, Response, Router } from "express";
import { z } from "zod";
import { collectionGet, docSet, docUpdate, docDelete } from "../fs.js";
import { requireAdmin } from "../middleware.js";
import { liveHub } from "../live.js";
import logger from "../logger.js";

const router = Router();

let cachedZones: any[] | null = null;

const zoneSchema = z.object({
  nameAr: z.string().min(2).max(120),
  nameFr: z.string().min(2).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  capacity: z.number().int().positive().max(100000),
  hasMedical: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

async function loadZones(): Promise<any[]> {
  if (cachedZones) return cachedZones;
  try {
    const fromDb = await collectionGet("safeZones", "createdAt", 100);
    cachedZones = fromDb || [];
    return cachedZones;
  } catch (err) {
    logger.error({ err }, "Safe zones read failed");
    throw err;
  }
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    const zones = await loadZones();
    res.json(zones.filter((z: any) => z.isActive !== false));
  } catch {
    res.status(503).json({ error: "Safe-zone data is currently unavailable" });
  }
});

router.post("/", requireAdmin, async (req: Request, res: Response) => {
  const parsed = zoneSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const id = `zone-${Date.now()}`;
  const zone = { id, ...parsed.data, createdAt: new Date().toISOString() };
  await docSet("safeZones", id, zone);
  cachedZones = cachedZones ? [zone, ...cachedZones] : [zone];
  liveHub.broadcast("safezones:changed", { id });
  res.json(zone);
});

router.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  const parsed = zoneSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const { id } = req.params;
  const existing = cachedZones?.find((z: any) => z.id === id) || {};
  const zone = { ...existing, id, ...parsed.data, updatedAt: new Date().toISOString() };
  await docSet("safeZones", id, zone);
  cachedZones = cachedZones?.map((z: any) => (z.id === id ? zone : z)) || [zone];
  liveHub.broadcast("safezones:changed", { id });
  res.json(zone);
});

router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  await docDelete("safeZones", id).catch(() => {});
  cachedZones = cachedZones?.filter((z: any) => z.id !== id) || null;
  liveHub.broadcast("safezones:changed", { id });
  res.json({ success: true });
});

export default router;
