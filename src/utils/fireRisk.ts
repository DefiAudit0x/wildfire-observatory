import { Report, SatelliteHotspot, WilayaStatus } from "../types";

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
 */
export function computeFireRisk(
  reports: Report[],
  satellites: SatelliteHotspot[],
  wilayas: WilayaStatus[]
): FireRiskResult {
  const active = reports.filter((r) => r.status === "pending" || r.status === "verified");
  const activeFires = active.length;
  const criticalFires = active.filter((r) => r.severity === "critical").length;
  const liveHotspots = satellites.filter((s) => !s.isFallback).length;

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