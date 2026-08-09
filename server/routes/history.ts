import { Request, Response, Router } from "express";
import { z } from "zod";
import { getReportsDbResult } from "../db.js";
import { citizenReports } from "../data.js";
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
  const reports = dbResult.status === "ok" ? dbResult.reports : citizenReports;

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

  for (const sos of getSosSummarySnapshot()) {
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