import { Request, Response, Router } from "express";
import { z } from "zod";
import { collectionGet, docSet, docUpdate, docDelete, docGet } from "../fs.js";
import { requireAdmin } from "../middleware.js";
import { liveHub } from "../live.js";
import logger from "../logger.js";

const router = Router();

let cachedZones: any[] | null = null;

const zoneSchema = z.object({
  nameAr: z.string().min(2).max(120),
  nameFr: z.string().min(2).max(120),
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  capacity: z.coerce.number().int().positive().max(100000),
  hasMedical: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

async function loadZones(): Promise<any[]> {
  if (cachedZones) return cachedZones;
  try {
    const fromDb = await collectionGet("safeZones", "createdAt", 1000);
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
  const id = `zone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const zone = { id, ...parsed.data, createdAt: new Date().toISOString() };
  if (!(await docSet("safeZones", id, zone))) {
    res.status(503).json({ error: "Safe-zone data is currently unavailable" });
    return;
  }
  cachedZones = null;
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
  const existing = cachedZones?.find((z: any) => z.id === id) || await docGet("safeZones", id);
  if (!existing) {
    res.status(404).json({ error: "Safe zone not found" });
    return;
  }
  const zone = { ...existing, id, ...parsed.data, createdAt: existing.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (!(await docSet("safeZones", id, zone))) {
    res.status(503).json({ error: "Safe-zone data is currently unavailable" });
    return;
  }
  cachedZones = null;
  liveHub.broadcast("safezones:changed", { id });
  res.json(zone);
});

router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!(await docDelete("safeZones", id))) {
    res.status(503).json({ error: "Safe-zone data is currently unavailable" });
    return;
  }
  cachedZones = null;
  liveHub.broadcast("safezones:changed", { id });
  res.json({ success: true });
});

export default router;
