import { Report, SatelliteHotspot, WilayaStatus } from "../types";
import { isFreshThreatTimestamp } from "./threats";

export type RiskLevel = "low" | "moderate" | "high" | "extreme";

export interface FireRiskResult {
  score: number;
  level: RiskLevel;
  activeFires: number;
  criticalFires: number;
  liveHotspots: number;
  topWilayaNameAr: string | null;
  topWilayaNameFr: string | null;
}

export function riskLevelFor(score: number): RiskLevel {
  if (score >= 75) return "extreme";
  if (score >= 50) return "high";
  if (score >= 25) return "moderate";
  return "low";
}

/**
 * Deterministic fire-risk index computed from the same data the UI displays:
 * active citizen reports, satellite hotspots and wilaya severity levels.
 * No external dependency, so it never "breaks" when a provider is down.
 *
 * W-M8 unified freshness: [now]-gated exactly like the radar/proximity
 * surfaces (isFreshThreatTimestamp, 30-min window). Stale reports/hotspots
 * used to keep inflating this score while the radar showed zero targets —
 * the contradictory-UI bug the owner reported. Both surfaces now share one
 * window, so the risk index can never claim danger the radar does not show.
 */
export function computeFireRisk(
  reports: Report[],
  satellites: SatelliteHotspot[],
  wilayas: WilayaStatus[],
  now: number = Date.now()
): FireRiskResult {
  const active = reports.filter(
    (r) =>
      (r.status === "pending" || r.status === "verified") &&
      isFreshThreatTimestamp(r.timestamp, now)
  );
  const activeFires = active.length;
  const criticalFires = active.filter((r) => r.severity === "critical").length;
  const liveHotspots = satellites.filter(
    (s) => !s.isFallback && isFreshThreatTimestamp(s.scanTime, now)
  ).length;

  let score = activeFires * 8 + criticalFires * 12 + Math.min(liveHotspots * 2, 20);
  const worstWilayaWeight = wilayas.reduce<number>((max, w) => {
    const weight =
      w.severity === "critical" ? 25 : w.severity === "high" ? 15 : w.severity === "medium" ? 8 : w.severity === "low" ? 3 : 0;
    return Math.max(max, weight);
  }, 0);
  score += worstWilayaWeight;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const severityRank = (w: WilayaStatus) =>
    w.severity === "critical" ? 4 : w.severity === "high" ? 3 : w.severity === "medium" ? 2 : 1;

  const threatened = [...wilayas]
    .filter((w) => w.severity !== "safe")
    .sort((a, b) => {
      const diff = severityRank(b) - severityRank(a);
      if (diff !== 0) return diff;
      return b.activeFires + b.satelliteHotspots - (a.activeFires + a.satelliteHotspots);
    })[0];

  return {
    score,
    level: riskLevelFor(score),
    activeFires,
    criticalFires,
    liveHotspots,
    topWilayaNameAr: threatened?.nameAr ?? null,
    topWilayaNameFr: threatened?.nameFr ?? null,
  };
}