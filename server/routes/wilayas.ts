import { Request, Response, Router } from "express";
import { wilayasStatus } from "../data.js";
import { getReportsFromFirestore } from "../db.js";
import { getLiveSatelliteData } from "./satellite.js";
import logger from "../logger.js";

const router = Router();

const SEVERITY_PRIORITY: Record<string, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

// W-M8 unified freshness: ONE window governs every "live incident" surface
// (radar, proximity banner, SOS corroboration, wilaya severity, risk index).
// A 3-week-old pending report used to keep driving a wilaya's severity and
// evacuation flag here while the map's radar showed zero targets — the exact
// contradictory-UI class of bug the owner reported. 30 min mirrors the
// client doctrine (src/utils/threats.ts THREAT_MAX_AGE_MS).
export const THREAT_MAX_AGE_MS = 30 * 60 * 1000;
export const THREAT_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

/** A threat timestamp must be parseable, recent, and not materially from the future. */
export function isFreshThreatTimestamp(value: unknown, now: number = Date.now()): boolean {
  const ts = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(ts)) return false;
  const age = now - ts;
  return age >= -THREAT_MAX_FUTURE_SKEW_MS && age <= THREAT_MAX_AGE_MS;
}

export interface WilayaSeverityInput {
  wilaya?: string;
  severity?: string;
  confidence?: number;
  status?: string;
  timestamp?: unknown;
  scanTime?: unknown;
}

/**
 * W-M8: pure derivation of per-wilaya live status from FRESH incidents only.
 * Reports and hotspots failing the unified 30-minute freshness window are
 * ignored exactly as the client radar ignores them — the two surfaces can
 * no longer disagree. Exported pure for tests.
 */
export function deriveWilayaStatuses<
  W extends { nameAr: string; nameFr: string; emergencyPhone: string }
>(
  base: W[],
  reports: WilayaSeverityInput[],
  hotspots: WilayaSeverityInput[],
  now: number = Date.now()
): Array<W & { activeFires: number; satelliteHotspots: number; severity: string; evacuationRecommended: boolean }> {
  const dynamicWilayas = base.map((w) => ({
    ...w,
    activeFires: 0,
    satelliteHotspots: 0,
    severity: "safe" as "safe" | "low" | "medium" | "high" | "critical" | string,
    evacuationRecommended: false,
  }));

  // ARC-M04 (kept): resolved/rejected reports are NOT active fires.
  // W-M8 (new): stale timestamps are not active incidents either — the
  // unified 30-minute window applies on top of the status filter.
  const freshReports = (reports || [])
    .filter((rep) => rep.status !== "resolved" && rep.status !== "rejected")
    .filter((rep) => isFreshThreatTimestamp(rep.timestamp, now));
  freshReports.forEach((rep) => {
    const match = dynamicWilayas.find((w) => wilayaMatches(rep.wilaya || "", w.nameAr, w.nameFr));
    if (match) {
      match.activeFires += 1;
      const repSeverity = rep.severity || "medium";
      if ((SEVERITY_PRIORITY[repSeverity] ?? 0) > SEVERITY_PRIORITY[match.severity]) {
        match.severity = repSeverity;
      }
      if (repSeverity === "critical") match.evacuationRecommended = true;
    }
  });

  const freshHotspots = (hotspots || []).filter((sat) => isFreshThreatTimestamp(sat.scanTime, now));
  freshHotspots.forEach((sat) => {
    const match = dynamicWilayas.find((w) => wilayaMatches(sat.wilaya || "", w.nameAr, w.nameFr));
    if (match) {
      match.satelliteHotspots += 1;
      if ((sat.confidence ?? 0) >= 80 && SEVERITY_PRIORITY[match.severity] < SEVERITY_PRIORITY.low) {
        match.severity = "low";
      }
    }
  });

  return dynamicWilayas;
}

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

  let currentReports: any[] = [];
  try {
    const firestoreReports = await getReportsFromFirestore();
    // ARC-M04 + W-M8: the ACTIVE filter (not resolved/rejected) is applied
    // by the caller below together with the freshness window — stale rows
    // must not drive severity even if Firestore still holds them.
    currentReports = firestoreReports || [];
  } catch (err) {
    logger.warn(
      { msg: err instanceof Error ? err.message : String(err) },
      "Wilayas route: Firestore reports unavailable — falling back to static baseline"
    );
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

  const response = deriveWilayaStatuses(wilayasStatus, currentReports, hotspots, now);
  cachedResponse = response;
  cacheTimestamp = now;
  res.setHeader("X-Last-Updated", new Date(now).toISOString());
  res.json(response);
});

export default router;
