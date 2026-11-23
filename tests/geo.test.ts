import { describe, it, expect } from "vitest";
import { getHaversineDistance, determineWilayaByCoords, runClustering, wilayaContainsCoords, canonicalizeWilaya, WILAYA_NAMES } from "../server/geo.js";
import { haversineKm, minDistanceToPolylineKm } from "../src/utils/geo.js";
import type { Report } from "../src/types";

describe("getHaversineDistance", () => {
  it("returns 0 for same point", () => {
    expect(getHaversineDistance(36.8, 7.5, 36.8, 7.5)).toBe(0);
  });

  it("returns correct distance between known points", () => {
    const dist = getHaversineDistance(36.75, 7.5, 36.85, 7.5);
    expect(dist).toBeGreaterThan(10);
    expect(dist).toBeLessThan(12);
  });

  it("is symmetric", () => {
    const a = getHaversineDistance(36.8, 7.5, 35.0, 6.0);
    const b = getHaversineDistance(35.0, 6.0, 36.8, 7.5);
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });
});

describe("determineWilayaByCoords", () => {
  it("identifies El Tarf, Algeria", () => {
    const result = determineWilayaByCoords(36.885, 8.423);
    expect(result).toContain("الطارف");
  });

  it("identifies Jendouba, Tunisia", () => {
    const result = determineWilayaByCoords(36.65, 8.78);
    expect(result).toContain("جندوبة");
  });

  it("identifies Tangier, Morocco", () => {
    const result = determineWilayaByCoords(35.58, -5.36);
    expect(result).toContain("طنجة");
  });

  it("identifies Al Jabal al Akhdar, Libya", () => {
    const result = determineWilayaByCoords(32.75, 21.85);
    expect(result).toContain("الجبل الأخضر");
  });

  it("no overlap: El Tarf vs Annaba boundary", () => {
    expect(determineWilayaByCoords(36.8, 8.2)).toContain("الطارف");
    expect(determineWilayaByCoords(36.85, 7.6)).toContain("عنابة");
    expect(determineWilayaByCoords(36.9, 7.9)).not.toContain("الطارف");
  });

  it("no overlap: Béjaïa vs Tizi Ouzou boundary", () => {
    expect(determineWilayaByCoords(36.6, 5.0)).toContain("بجاية");
    expect(determineWilayaByCoords(36.6, 4.2)).toContain("تيزي وزو");
    expect(determineWilayaByCoords(36.7, 4.45)).not.toContain("بجاية");
    expect(determineWilayaByCoords(36.7, 5.0)).not.toContain("تيزي وزو");
  });
});

describe("wilayaContainsCoords", () => {
  it("accepts coordinates inside a known wilaya bounds entry", () => {
    expect(wilayaContainsCoords("الجزائر - تيزي وزو (Algérie - Tizi Ouzou)", 36.6, 4.2)).toBe(true);
  });

  it("rejects an unbounded wilaya instead of accepting country-level coverage", () => {
    expect(wilayaContainsCoords("الجزائر - البليدة (Algérie - Blida)", 36.75, 3.05)).toBe(false);
  });
});

describe("runClustering", () => {
  it("clusters nearby reports", () => {
    const reports: Report[] = [
      { id: "a", lat: 36.88, lng: 8.42, severity: "high", status: "verified", timestamp: new Date().toISOString(), consensusCount: 5, reporterType: "citizen", locationName: "A", wilaya: "test", description: "test" },
      { id: "b", lat: 36.882, lng: 8.425, severity: "high", status: "verified", timestamp: new Date().toISOString(), consensusCount: 3, reporterType: "citizen", locationName: "B", wilaya: "test", description: "test" },
      { id: "c", lat: 37.0, lng: 9.0, severity: "medium", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen", locationName: "C", wilaya: "test", description: "test" },
    ];
    const result = runClustering(reports);
    const clusterA = result.find((r) => r.id === "a");
    const clusterB = result.find((r) => r.id === "b");
    const clusterC = result.find((r) => r.id === "c");
    expect(clusterA?.clusterId).toBe(clusterB?.clusterId);
    expect(clusterA?.clusterSize).toBe(2);
    expect(clusterC?.clusterSize).toBe(1);
  });

  it("does not cluster distant reports", () => {
    const reports: Report[] = [
      { id: "a", lat: 36.88, lng: 8.42, severity: "low", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen", locationName: "A", wilaya: "test", description: "test" },
      { id: "b", lat: 37.0, lng: 9.0, severity: "low", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen", locationName: "B", wilaya: "test", description: "test" },
    ];
    const result = runClustering(reports);
    expect(result[0].clusterSize).toBe(1);
    expect(result[1].clusterSize).toBe(1);
    expect(result[0].clusterId).not.toBe(result[1].clusterId);
  });
});

describe("v2.15.0: overlapping-rectangle disambiguation", () => {
  it("classifies a point in the Annaba∩Skikda overlap by the SMALLEST containing rectangle (deterministic)", () => {
    // (36.85, 7.45) sits inside Annaba (36.7-37.0 / 7.4-7.95, area 0.15) AND
    // Skikda (36.6-37.0 / 6.2-7.5, area 0.32). The old first-match `find()`
    // answered by array order; the smallest-area rule is stable and specific.
    expect(determineWilayaByCoords(36.85, 7.45)).toContain("عنابة");
  });

  it("still resolves unambiguous wilayas correctly", () => {
    expect(determineWilayaByCoords(36.95, 7.7)).toContain("عنابة"); // Annaba only
    expect(determineWilayaByCoords(36.95, 6.4)).toContain("سكيكدة"); // Skikda only (outside Jijel lat cap)
  });
});

describe("canonicalizeWilaya (Fix 8c — legacy stored region aliases)", () => {
  const ANNABA = "الجزائر - عنابة (Algérie - Annaba)";

  it("returns a canonical label unchanged", () => {
    expect(canonicalizeWilaya(ANNABA)).toBe(ANNABA);
  });

  it("maps a French region name to its canonical label", () => {
    expect(canonicalizeWilaya("Annaba")).toBe(ANNABA);
    expect(canonicalizeWilaya("annaba")).toBe(ANNABA);
    expect(canonicalizeWilaya("  Annaba  ")).toBe(ANNABA);
  });

  it("maps an Arabic region name to its canonical label", () => {
    expect(canonicalizeWilaya("عنابة")).toBe(ANNABA);
  });

  it("maps a country-region side to its canonical label", () => {
    expect(canonicalizeWilaya("Algérie - Annaba")).toBe(ANNABA);
    expect(canonicalizeWilaya("الجزائر - عنابة")).toBe(ANNABA);
  });

  it("maps every canonical label's regions back to itself", () => {
    for (const name of WILAYA_NAMES) {
      expect(canonicalizeWilaya(name)).toBe(name);
    }
  });

  it("returns an unrecognizable alias unchanged instead of guessing", () => {
    expect(canonicalizeWilaya("Atlantis")).toBe("Atlantis");
    expect(canonicalizeWilaya("Algiers")).toBe("Algiers");
    expect(canonicalizeWilaya("")).toBe("");
  });
});

describe("minDistanceToPolylineKm (Fix 25 — EVAC-1)", () => {
  it("returns 0 for the report's repro: a fire exactly at the destination the old stride skipped", () => {
    // The old every-4th-vertex stride checked only [5,36] and reported
    // 2.69875754966081 km for a fire sitting exactly on the road.
    const route: [number, number][] = [[5, 36], [5.01, 36], [5.02, 36], [5.03, 36]];
    expect(minDistanceToPolylineKm(route, 36, 5.03)).toBe(0);
    expect(haversineKm(36, 5, 36, 5.03)).toBeCloseTo(2.69875754966081, 5);
  });

  it("returns 0 for a fire at the midpoint of a long segment", () => {
    const route: [number, number][] = [[5, 36], [5.1, 36]];
    expect(minDistanceToPolylineKm(route, 36, 5.05)).toBeCloseTo(0, 9);
  });

  it("returns a large distance for a far fire", () => {
    const route: [number, number][] = [[5, 36], [5.01, 36], [5.02, 36], [5.03, 36]];
    expect(minDistanceToPolylineKm(route, 37, 5.03)).toBeGreaterThan(100);
  });

  it("measures a fire beside the road, not just its endpoints", () => {
    // 1 km north of the midpoint of a ~9 km east-west road.
    const route: [number, number][] = [[5, 36], [5.1, 36]];
    const d = minDistanceToPolylineKm(route, 36.009, 5.05);
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThan(1.1);
  });

  it("reduces to point distance for a single-point geometry", () => {
    expect(minDistanceToPolylineKm([[5, 36]], 36, 5.03)).toBeCloseTo(haversineKm(36, 5, 36, 5.03), 3);
  });

  it("treats duplicate consecutive vertices as that point, without NaN or Infinity", () => {
    const route: [number, number][] = [[5, 36], [5, 36], [5.03, 36]];
    const d = minDistanceToPolylineKm(route, 36, 5.03);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBe(0);
  });

  it("returns Infinity for an empty geometry", () => {
    expect(minDistanceToPolylineKm([], 36, 5.03)).toBe(Infinity);
  });
});
