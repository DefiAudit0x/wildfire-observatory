import { describe, it, expect } from "vitest";
import { getNearestActiveThreat } from "../src/utils/threats.js";
import { determineWilayaByCoords, OUT_OF_COVERAGE } from "../src/utils/geo.js";
import type { Report, SatelliteHotspot } from "../src/types.js";

function mkReport(over: Record<string, unknown>): Report {
  return {
    id: "r-default",
    lat: 36.8,
    lng: 7.6,
    locationName: "اختبار",
    wilaya: "الجزائر - عنابة (Algérie - Annaba)",
    description: "بلاغ اختبار",
    severity: "medium",
    status: "pending",
    timestamp: new Date().toISOString(),
    consensusCount: 1,
    ...over,
  } as Report;
}

function mkSatellite(id: string, over: Record<string, unknown> = {}): SatelliteHotspot {
  return {
    id,
    lat: 36.82,
    lng: 7.62,
    confidence: 90,
    brightness: 400,
    scanTime: new Date().toISOString(),
    satellite: "VIIRS",
    wilaya: "",
    ...over,
  } as SatelliteHotspot;
}

describe("getNearestActiveThreat — single definition of nearby danger", () => {
  it("groups reports of the same cluster into ONE incident (3 reports ≠ 3 fires)", () => {
    const result = getNearestActiveThreat({
      lat: 36.8,
      lng: 7.6,
      reports: [
        mkReport({ id: "a", clusterId: "cluster-1" }),
        mkReport({ id: "b", lat: 36.81, lng: 7.61, clusterId: "cluster-1" }),
        mkReport({ id: "c", lat: 36.79, lng: 7.59, clusterId: "cluster-1" }),
      ],
    });
    expect(result.nearbyIncidents).toBe(1);
  });

  it("counts two distinct clusters as two incidents", () => {
    const result = getNearestActiveThreat({
      lat: 36.8,
      lng: 7.6,
      reports: [
        mkReport({ id: "a", clusterId: "cluster-1" }),
        mkReport({ id: "b", lat: 36.75, lng: 7.55, clusterId: "cluster-2" }),
      ],
    });
    expect(result.nearbyIncidents).toBe(2);
  });

  it("ignores resolved/rejected reports and low-confidence satellites", () => {
    const result = getNearestActiveThreat({
      lat: 36.8,
      lng: 7.6,
      reports: [
        mkReport({ id: "a", status: "resolved" }),
        mkReport({ id: "b", status: "rejected" }),
        mkReport({ id: "c", lat: 36.9, lng: 7.7 }), // within 10km -> 13km? 0.1deg lat ≈ 11km
      ],
      satellites: [mkSatellite("s1", { confidence: 40 })],
    });
    expect(result.nearbyIncidents).toBe(0);
    // "c" is ~12km away (0.1 lat deg) -> outside the 10km radius, so no nearby sources
    expect(result.nearbySources.length).toBe(0);
  });

  it("dedupes cluster members out of the 10km radius counts but keeps the nearest", () => {
    const result = getNearestActiveThreat({
      lat: 36.8,
      lng: 7.6,
      reports: [
        mkReport({ id: "near", clusterId: "cluster-1" }),
        mkReport({ id: "far", lat: 36.95, lng: 7.75, clusterId: "cluster-9" }),
      ],
    });
    expect(result.nearest?.reportId).toBe("near");
    expect(result.nearbyIncidents).toBe(1);
  });

  it("selects the closest source across reports and satellites (satellites >= 70)", () => {
    const result = getNearestActiveThreat({
      lat: 36.8,
      lng: 7.6,
      reports: [mkReport({ id: "r", lat: 36.85, lng: 7.65 })],
      satellites: [
        mkSatellite("s1", { lat: 36.801, lng: 7.601 }),
        mkSatellite("s2", { confidence: 60 }),
      ],
    });
    expect(result.nearest?.kind).toBe("satellite");
    expect(result.nearest?.satelliteId).toBe("s1");
    expect(result.nearbyIncidents).toBe(1);
  });

  it("excludes stale sources and separates verified from pending clusters", () => {
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const result = getNearestActiveThreat({
      lat: 36.8,
      lng: 7.6,
      now,
      reports: [
        mkReport({ id: "verified", status: "verified", timestamp: "2026-08-13T11:59:00.000Z", clusterId: "v" }),
        mkReport({ id: "pending", status: "pending", timestamp: "2026-08-13T11:58:00.000Z", clusterId: "p" }),
        mkReport({ id: "stale", status: "verified", timestamp: "2026-08-13T11:00:00.000Z", clusterId: "stale" }),
      ],
      satellites: [mkSatellite("fresh-satellite", { scanTime: "2026-08-13T11:59:00.000Z" })],
    });
    expect(result.nearbyIncidents).toBe(2);
    expect(result.nearbyVerifiedIncidents).toBe(1);
    expect(result.nearbyPendingIncidents).toBe(1);
    expect(result.nearbySources.some((source) => source.reportId === "stale")).toBe(false);
  });
});

describe("determineWilayaByCoords (client mirror of server geofence)", () => {
  it("resolves fine-grained bounds (El Tarf)", () => {
    expect(determineWilayaByCoords(36.885, 8.423)).toContain("الطارف");
  });

  it("resolves Moroccan region bounds (Tanger)", () => {
    expect(determineWilayaByCoords(35.58, -5.36)).toContain("طنجة");
  });

  it("falls back to the country-level heuristic inside North Africa", () => {
    expect(determineWilayaByCoords(35.5, 3.3)).toBe("الجزائر - منطقة أخرى (Algérie - Autre)");
  });

  it("marks positions outside coverage (north of all fallback bands)", () => {
    expect(determineWilayaByCoords(38.5, 3.0)).toBe(OUT_OF_COVERAGE);
  });
});