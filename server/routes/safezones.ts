import { Request, Response, Router } from "express";
import { z } from "zod";
import { collectionGet, docSet, docUpdate, docDelete, docGet } from "../fs.js";
import { requireAdmin } from "../middleware.js";
import { str } from "../params.js";
import { liveHub } from "../live.js";
import logger from "../logger.js";

const router = Router();

const ZONES_CACHE_TTL_MS = 60 * 1000;
let cachedZones: { data: any[]; expiresAt: number } | null = null;

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
  const now = Date.now();
  // ARC-M07 fix: the cache used to live forever until an in-place write — zones
  // added by another instance (or directly in Firestore) never appeared, and a
  // failure snapshot froze the served list at whatever it happened to hold.
  if (cachedZones && now < cachedZones.expiresAt) return cachedZones.data;
  try {
    const fromDb = await collectionGet("safeZones", "createdAt", 1000);
    if (fromDb === null) throw new Error("safe-zone database read unavailable");
    cachedZones = { data: fromDb, expiresAt: now + ZONES_CACHE_TTL_MS };
    return cachedZones.data;
  } catch (err) {
    if (cachedZones) {
      logger.warn({ err }, "Safe zones read failed — serving the stale cached copy");
      return cachedZones.data;
    }
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
  const id = str(req.params.id);
  try {
    const existing = (await loadZones()).find((z: any) => z.id === id);
    if (!existing) {
      res.status(404).json({ error: "Safe zone not found" });
      return;
    }
    // v2.15.0 audit fix (lost update): the update used to spread the
    // possibly-stale cached `existing` over the WHOLE document and write it
    // back with docSet — a second admin instance (or any writer) committing
    // inside the 60s zone cache TTL (plus the 30s collection cache) had its
    // fields silently reverted. The write is now a MERGE of only the fields
    // this request owns (docUpdate), so concurrent writers compose instead
    // of overwrite; the merged result is recomputed for the response.
    const merged = { ...existing, ...parsed.data, id, createdAt: existing.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (!(await docUpdate("safeZones", id, { ...parsed.data, updatedAt: merged.updatedAt }))) {
      res.status(503).json({ error: "Safe-zone data is currently unavailable" });
      return;
    }
    cachedZones = null;
    liveHub.broadcast("safezones:changed", { id });
    res.json(merged);
  } catch (err) {
    logger.error({ err, id }, "Safe zone update failed");
    res.status(503).json({ error: "Safe-zone data is currently unavailable" });
  }
});

router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = str(req.params.id);
  try {
    const existing = (await loadZones()).find((z: any) => z.id === id);
    if (!existing) {
      res.status(404).json({ error: "Safe zone not found" });
      return;
    }
    if (!(await docDelete("safeZones", id))) {
      res.status(503).json({ error: "Safe-zone data is currently unavailable" });
      return;
    }
    cachedZones = null;
    liveHub.broadcast("safezones:changed", { id });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err, id }, "Safe zone deletion failed");
    res.status(503).json({ error: "Safe-zone data is currently unavailable" });
  }
});

export default router;
