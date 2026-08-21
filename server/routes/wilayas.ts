import { Request, Response, Router } from "express";
import { wilayasStatus } from "../data.js";
import { getReportsDbResult } from "../db.js";
import { getLiveSatelliteData } from "./satellite.js";
import { validateReports } from "../report-validation.js";
import logger from "../logger.js";

const router = Router();

const SEVERITY_PRIORITY: Record<string, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

const CACHE_TTL_MS = 60 * 1000;
let cachedResponse: unknown = null;
let cacheTimestamp = 0;

export function normalizeWilayaName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[éèêë]/g, "e")
    .replace(/[àâä]/g, "a")
    .replace(/[îï]/g, "i")
    .replace(/[ôö]/g, "o")
    .replace(/[ûüù]/g, "u")
    .replace(/ç/g, "c")
    .replace(/[''`]/g, " ")
    .replace(/[()\-–,._\/]/g, " ")
    .replace(
      /wilaya|wilaya de|ولاية|الجزائر|alg[ée]rie|tunisie|maroc|libye|تونس|المغرب|ليبيا/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function wilayaMatches(input: string, nameAr: string, nameFr: string): boolean {
  const normalizedInput = normalizeWilayaName(input);
  if (!normalizedInput) return false;

  const candidates = [normalizeWilayaName(nameAr), normalizeWilayaName(nameFr)];
  for (const candidate of candidates) {
    if (candidate === normalizedInput) return true;
    if (candidate.includes(normalizedInput) && normalizedInput.length >= 3) return true;
  }
  const allCandidateWords = new Set(candidates.flatMap((c) => c.split(" ")));
  const meaningfulInputWords = normalizedInput.split(" ").filter((word) => word.length >= 3);
  return (
    meaningfulInputWords.length > 0 &&
    meaningfulInputWords.every((word) => allCandidateWords.has(word))
  );
}

router.get("/", async (_req: Request, res: Response) => {
  const now = Date.now();
  if (cachedResponse && now - cacheTimestamp < CACHE_TTL_MS) {
    return res.json(cachedResponse);
  }

  const dbResult = await getReportsDbResult();
  const sourceReports = dbResult.status === "ok"
    ? dbResult.reports
    : dbResult.status === "no-db" && process.env.NODE_ENV !== "production"
      ? (await import("../data.js")).citizenReports
      : null;
  const currentReports = sourceReports ? validateReports(sourceReports) : null;
  if (!currentReports) {
    res.status(503).json({ code: "REPORT_DATA_UNAVAILABLE", error: "Report data is currently unavailable" });
    return;
  }

  let hotspots: any[] = [];
  try {
    hotspots = await getLiveSatelliteData();
  } catch (err) {
    logger.warn(
      { msg: err instanceof Error ? err.message : String(err) },
      "Wilayas route: satellite data unavailable"
    );
  }

  const dynamicWilayas = wilayasStatus.map((w) => ({
    ...w,
    activeFires: 0,
    satelliteHotspots: 0,
    severity: "safe" as "safe" | "low" | "medium" | "high" | "critical" | string,
    evacuationRecommended: false,
  }));

  currentReports.forEach((rep: any) => {
    const match = dynamicWilayas.find((w) =>
      wilayaMatches(rep.wilaya || "", w.nameAr, w.nameFr)
    );
    if (match) {
      match.activeFires += 1;
      const repSeverity = rep.severity || "medium";
      if ((SEVERITY_PRIORITY[repSeverity] ?? 0) > SEVERITY_PRIORITY[match.severity]) {
        match.severity = repSeverity;
      }
      if (repSeverity === "critical") match.evacuationRecommended = true;
    }
  });

  hotspots.forEach((sat: any) => {
    const match = dynamicWilayas.find((w) =>
      wilayaMatches(sat.wilaya || "", w.nameAr, w.nameFr)
    );
    if (match) {
      match.satelliteHotspots += 1;
      if (sat.confidence >= 80 && SEVERITY_PRIORITY[match.severity] < SEVERITY_PRIORITY.low) {
        match.severity = "low";
      }
    }
  });

  const response = dynamicWilayas;
  cachedResponse = response;
  cacheTimestamp = now;
  res.setHeader("X-Last-Updated", new Date(now).toISOString());
  res.json(response);
});

export default router;
