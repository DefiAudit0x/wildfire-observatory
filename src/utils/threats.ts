import { Report, SatelliteHotspot } from "../types";
import { haversineKm } from "./geo";

export interface ThreatSource {
  lat: number;
  lng: number;
  kind: "report" | "satellite";
  reportId?: string;
  clusterId?: string;
  satelliteId?: string;
  confidence?: number;
  distanceKm: number;
}

export interface ThreatAnalysis {
  /** Closest active threat (citizen report or high-confidence satellite hotspot). */
  nearest: ThreatSource | null;
  /** Distinct active fire clusters within 10 km (reports are grouped by clusterId — one fire, not one report). */
  nearbyIncidents: number;
  /** All active report/satellite sources within 10 km. */
  nearbySources: ThreatSource[];
}

const NEARBY_RADIUS_KM = 10;
const SATELLITE_MIN_CONFIDENCE = 70;

/**
 * Single source of truth for "how close is the danger".
 * Used by the Home emergency banner and the distance-to-fire computations:
 * citizen reports (pending/verified, clustered) + satellite hotspots >= 70%.
 */
export function getNearestActiveThreat(opts: {
  lat: number;
  lng: number;
  reports: Report[];
  satellites?: SatelliteHotspot[];
}): ThreatAnalysis {
  const { lat, lng, reports, satellites = [] } = opts;

  // NaN invariant enforcement at the boundary: non-finite coordinates are
  // never measured (NaN distances break every comparison downstream — a NaN
  // "nearest" source would win reduce() and poison the banner), and a NaN
  // observer position yields an empty analysis, not garbage distances.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { nearest: null, nearbyIncidents: 0, nearbySources: [] };
  }

  const sources: ThreatSource[] = [
    ...reports
      .filter(
        (r) =>
          (r.status === "pending" || r.status === "verified") &&
          Number.isFinite(r.lat) &&
          Number.isFinite(r.lng)
      )
      .map((r) => ({
        lat: r.lat,
        lng: r.lng,
        kind: "report" as const,
        reportId: r.id,
        clusterId: r.clusterId,
        distanceKm: haversineKm(lat, lng, r.lat, r.lng),
      })),
    ...satellites
      .filter(
        (s) =>
          s.confidence >= SATELLITE_MIN_CONFIDENCE &&
          Number.isFinite(s.lat) &&
          Number.isFinite(s.lng)
      )
      .map((s) => ({
        lat: s.lat,
        lng: s.lng,
        kind: "satellite" as const,
        satelliteId: s.id,
        confidence: s.confidence,
        distanceKm: haversineKm(lat, lng, s.lat, s.lng),
      })),
  ];

  if (sources.length === 0) {
    return { nearest: null, nearbyIncidents: 0, nearbySources: [] };
  }

  const nearbySources = sources.filter((s) => s.distanceKm <= NEARBY_RADIUS_KM);
  const incidentKeys = new Set(
    nearbySources
      .filter((s) => s.kind === "report")
      .map((s) => s.clusterId || s.reportId || "")
      .filter(Boolean)
  );

  const nearest = sources.reduce((a, b) => (b.distanceKm < a.distanceKm ? b : a));

  return { nearest, nearbyIncidents: incidentKeys.size, nearbySources };
}