import { Request, Response, Router } from "express";
import { z } from "zod";
import { getReportsDbResult } from "../db.js";
import { collectionGet } from "../fs.js";
import { getLiveSatelliteData } from "./satellite.js";
import { getSosSummarySnapshot } from "./sos.js";

const router = Router();

const historyQuery = z.object({
  days: z.coerce.number().int().min(7).max(180).optional(),
});

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

router.get("/", async (_req: Request, res: Response) => {
  const reqQuery = historyQuery.safeParse(_req.query);
  const days = reqQuery.success && reqQuery.data.days ? reqQuery.data.days : 30;

  const dbResult = await getReportsDbResult();
  // v2.3.0 (simulation purge): no demo-seed fallback — a database outage or an
  // empty collection means an honest all-zero history chart.
  const reports = dbResult.status === "ok" ? dbResult.reports : [];

  const buckets = new Map<string, { reports: number; verified: number; sos: number; hotspots: number }>();
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    buckets.set(day.toISOString().slice(0, 10), { reports: 0, verified: 0, sos: 0, hotspots: 0 });
  }

  for (const report of reports) {
    const bucket = buckets.get(dayKey(report.timestamp || ""));
    if (!bucket) continue;
    bucket.reports += 1;
    if (report.status === "verified") bucket.verified += 1;
  }

  // ARC-M12 fix: the SOS daily counts used to come exclusively from the
  // process-local memory window (capped at 200 items, swept every 12h), which
  // made the history panel show almost zero SOS on any real deployment — and
  // different numbers per instance. Read the durable collection (metadata only
  // reaches this route anyway) and keep the memory snapshot as fallback.
  let sosItems: Array<{ timestamp: string }> = [];
  try {
    const fromDb = await collectionGet("trappedSos", "timestamp", 500);
    if (fromDb !== null) {
      sosItems = fromDb.map((s: any) => ({ timestamp: String(s.timestamp || "") }));
    }
  } catch {
    // fall through to the memory snapshot below
  }
  if (sosItems.length === 0) {
    sosItems = getSosSummarySnapshot();
  }
  for (const sos of sosItems) {
    const bucket = buckets.get(dayKey(sos.timestamp));
    if (bucket) bucket.sos += 1;
  }

  const hotspots = await getLiveSatelliteData();
  for (const hotspot of hotspots) {
    const bucket = buckets.get(dayKey(hotspot.scanTime));
    if (bucket) bucket.hotspots += 1;
  }

  res.json({
    days,
    generatedAt: new Date().toISOString(),
    buckets: [...buckets.entries()].map(([date, counts]) => ({ date, ...counts })),
  });
});

export default router;