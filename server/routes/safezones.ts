import { Request, Response, Router } from "express";
import { z } from "zod";
import { collectionGet, docSet, docUpdate, docDelete, docGet } from "../fs.js";
import { requireAdmin } from "../middleware.js";
import { str } from "../params.js";
import { liveHub } from "../live.js";
import logger from "../logger.js";

const router = Router();

const ZONES_CACHE_TTL_MS = 60 * 1000;
// Five existing 60-second TTLs is the absolute last-success age, not an
// extension renewed by each failed refresh (centres may have been disabled).
const ZONES_MAX_STALE_AGE_MS = 5 * ZONES_CACHE_TTL_MS;
type ZonesData = NonNullable<Awaited<ReturnType<typeof collectionGet>>>;
type ZonesResult = { data: ZonesData; stale: boolean; loadedAt: number };
let cachedZones: { data: ZonesData; expiresAt: number; loadedAt: number } | null = null;

let zonesGeneration = 0;

const zoneSchema = z.object({
  nameAr: z.string().min(2).max(120),
  nameFr: z.string().min(2).max(120),
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  capacity: z.coerce.number().int().positive().max(100000),
  hasMedical: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

async function loadZones(): Promise<ZonesResult> {
  const now = Date.now();
  // ARC-M07 fix: the cache used to live forever until an in-place write — zones
  // added by another instance (or directly in Firestore) never appeared, and a
  // failure snapshot froze the served list at whatever it happened to hold.
  if (cachedZones && now < cachedZones.expiresAt) return { data: cachedZones.data, stale: false, loadedAt: cachedZones.loadedAt };
  const generation = zonesGeneration;
  try {
    const fromDb = await collectionGet("safeZones", "createdAt", 1000);
    if (fromDb === null) throw new Error("safe-zone database read unavailable");
    if (generation === zonesGeneration) {
      cachedZones = { data: fromDb, expiresAt: now + ZONES_CACHE_TTL_MS, loadedAt: now };
    }
    return { data: fromDb, stale: false, loadedAt: now };
  } catch (err) {
    if (cachedZones && Date.now() - cachedZones.loadedAt <= ZONES_MAX_STALE_AGE_MS) {
      logger.warn({ err }, "Safe zones read failed — serving the stale cached copy");
      return { data: cachedZones.data, stale: true, loadedAt: cachedZones.loadedAt };
    }
    logger.error({ err }, "Safe zones read failed");
    throw err;
  }
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    const zones = await loadZones();
    if (zones.stale) {
      res.setHeader("X-Data-Stale", "true");
      res.setHeader("X-Data-Updated-At", new Date(zones.loadedAt).toISOString());
    }
    res.json(zones.data.filter((z: any) => z.isActive !== false));
  } catch {
    res.status(503).json({ error: "Safe-zone data is currently unavailable" });
  }
});

// Fix 26 (SZM-1): the manager needs the records the public GET hides —
// inactive centres must be listed to be reactivated. Same loadZones(),
// same stale headers and 503 as the public route, but unfiltered and
// admin-only (the /api/sos/full + /api/reports/:id/identity precedent).
// The public route above stays exactly as it is: citizens never see
// inactive centres.
router.get("/admin", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const zones = await loadZones();
    if (zones.stale) {
      res.setHeader("X-Data-Stale", "true");
      res.setHeader("X-Data-Updated-At", new Date(zones.loadedAt).toISOString());
    }
    res.json(zones.data);
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
  zonesGeneration += 1;
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
    const existing = (await loadZones()).data.find((z: any) => z.id === id);
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
    zonesGeneration += 1;
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
    const existing = (await loadZones()).data.find((z: any) => z.id === id);
    if (!existing) {
      res.status(404).json({ error: "Safe zone not found" });
      return;
    }
    if (!(await docDelete("safeZones", id))) {
      res.status(503).json({ error: "Safe-zone data is currently unavailable" });
      return;
    }
    zonesGeneration += 1;
    cachedZones = null;
    liveHub.broadcast("safezones:changed", { id });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err, id }, "Safe zone deletion failed");
    res.status(503).json({ error: "Safe-zone data is currently unavailable" });
  }
});

export default router;
