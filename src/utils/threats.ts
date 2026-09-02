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
  status?: Report["status"];
  distanceKm: number;
}

export interface ThreatAnalysis {
  /** Closest fresh threat source (citizen report or high-confidence satellite hotspot). */
  nearest: ThreatSource | null;
  /** Distinct pending/verified report clusters within 10 km (legacy aggregate). */
  nearbyIncidents: number;
  /** Distinct verified report clusters within 10 km. */
  nearbyVerifiedIncidents: number;
  /** Distinct pending report clusters within 10 km. */
  nearbyPendingIncidents: number;
  /** All fresh active report/satellite sources within 10 km. */
  nearbySources: ThreatSource[];
}

// v1.0.4: widened from 3 min to 30 min. The old 3-minute window contradicted
// the data it gated: FIRMS satellite scan times are the OVERPASS moment
// (typically 10+ minutes old by the time they are fetched), so real satellite
// hotspots were NEVER "active threats" and the SOS flow kept saying "no active
// fires near you" while the proximity banner (which had NO freshness filter at
// all) still screamed about stale seed data — the contradictory UI the owner
// reported. 30 min matches how long a fire stays operationally "active" after
// a satellite pass or a citizen report, and both surfaces now share THIS
// constant through isFreshThreatTimestamp.
export const THREAT_MAX_AGE_MS = 30 * 60_000;
export const THREAT_MAX_FUTURE_SKEW_MS = 2 * 60_000;
const NEARBY_RADIUS_KM = 10;
const SATELLITE_MIN_CONFIDENCE = 70;

/** A threat timestamp must be parseable, recent, and not materially from the future. */
export function isFreshThreatTimestamp(value: unknown, now = Date.now()): boolean {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= -THREAT_MAX_FUTURE_SKEW_MS && age <= THREAT_MAX_AGE_MS;
}

/**
 * Single source of truth for "how close is the danger".
 * Used by the Home emergency banner and the distance-to-fire computations:
 * fresh citizen reports (pending/verified, clustered) + fresh satellite
 * hotspots >= 70% confidence.
 */
export function getNearestActiveThreat(opts: {
  lat: number;
  lng: number;
  reports: Report[];
  satellites?: SatelliteHotspot[];
  now?: number;
}): ThreatAnalysis {
  const { lat, lng, reports, satellites = [], now = Date.now() } = opts;

  // NaN invariant enforcement at the boundary: non-finite coordinates are
  // never measured (NaN distances break every comparison downstream — a NaN
  // "nearest" source would win reduce() and poison the banner), and a NaN
  // observer position yields an empty analysis, not garbage distances.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      nearest: null,
      nearbyIncidents: 0,
      nearbyVerifiedIncidents: 0,
      nearbyPendingIncidents: 0,
      nearbySources: [],
    };
  }

  const sources: ThreatSource[] = [
    ...reports
      .filter(
        (r) =>
          (r.status === "pending" || r.status === "verified") &&
          isFreshThreatTimestamp(r.timestamp, now) &&
          Number.isFinite(r.lat) &&
          Number.isFinite(r.lng)
      )
      .map((r) => ({
        lat: r.lat,
        lng: r.lng,
        kind: "report" as const,
        reportId: r.id,
        clusterId: r.clusterId,
        status: r.status,
        distanceKm: haversineKm(lat, lng, r.lat, r.lng),
      })),
    ...satellites
      .filter(
        (s) =>
          s.confidence >= SATELLITE_MIN_CONFIDENCE &&
          isFreshThreatTimestamp(s.scanTime, now) &&
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
    return {
      nearest: null,
      nearbyIncidents: 0,
      nearbyVerifiedIncidents: 0,
      nearbyPendingIncidents: 0,
      nearbySources: [],
    };
  }

  const nearbySources = sources.filter((s) => s.distanceKm <= NEARBY_RADIUS_KM);
  const reportSources = nearbySources.filter((s) => s.kind === "report");
  const incidentKeys = new Set(
    reportSources.map((s) => s.clusterId || s.reportId || "").filter(Boolean)
  );
  const verifiedIncidentKeys = new Set(
    reportSources
      .filter((s) => s.status === "verified")
      .map((s) => s.clusterId || s.reportId || "")
      .filter(Boolean)
  );
  const pendingIncidentKeys = new Set(
    reportSources
      .filter((s) => s.status === "pending")
      .map((s) => s.clusterId || s.reportId || "")
      .filter(Boolean)
  );

  const nearest = sources.reduce((a, b) => (b.distanceKm < a.distanceKm ? b : a));

  return {
    nearest,
    nearbyIncidents: incidentKeys.size,
    nearbyVerifiedIncidents: verifiedIncidentKeys.size,
    nearbyPendingIncidents: pendingIncidentKeys.size,
    nearbySources,
  };
}
