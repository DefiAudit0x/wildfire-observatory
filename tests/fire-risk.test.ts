import { describe, it, expect } from "vitest";
import { computeFireRisk, riskLevelFor } from "../src/utils/fireRisk";
import type { Report, SatelliteHotspot, WilayaStatus } from "../src/types";

const NOW = Date.parse("2026-08-01T10:00:00Z");

const baseReport: Report = {
  id: "r",
  lat: 36.7,
  lng: 7.6,
  locationName: "x",
  wilaya: "الجزائر - عنابة (Algérie - Annaba)",
  description: "x",
  severity: "medium",
  status: "pending",
  // 5 minutes before NOW — inside the unified 30-min freshness window.
  timestamp: "2026-08-01T09:55:00Z",
  consensusCount: 0,
};

const sat = (id: string, fallback = false): SatelliteHotspot => ({
  id,
  lat: 36.8,
  lng: 7.7,
  brightness: 320,
  confidence: 80,
  // 15 minutes before NOW — inside the unified freshness window.
  scanTime: "2026-08-01T09:45:00Z",
  satellite: "VIIRS",
  wilaya: "الجزائر - عنابة (Algérie - Annaba)",
  isFallback: fallback,
});

const wilaya = (severity: WilayaStatus["severity"]): WilayaStatus => ({
  nameAr: "عنابة",
  nameFr: "Annaba",
  activeFires: 1,
  satelliteHotspots: 2,
  severity,
  evacuationRecommended: false,
  emergencyPhone: "1021",
});

describe("computeFireRisk", () => {
  it("returns score 0 and low level when nothing is active", () => {
    const risk = computeFireRisk([], [], [wilaya("safe")], NOW);
    expect(risk.score).toBe(0);
    expect(risk.level).toBe("low");
  });

  it("ignores resolved reports and fallback hotspots", () => {
    const resolved = { ...baseReport, status: "resolved" as const, severity: "critical" as const };
    const risk = computeFireRisk([resolved], [sat("s", true)], [wilaya("safe")], NOW);
    expect(risk.score).toBe(0);
    expect(risk.activeFires).toBe(0);
  });

  it("escalates with critical fires (high level)", () => {
    const criticals = [0, 1, 2].map((i) => ({ ...baseReport, id: `r${i}`, severity: "critical" as const }));
    const risk = computeFireRisk(criticals, [sat("s1"), sat("s2"), sat("s3")], [wilaya("safe")], NOW);
    expect(risk.activeFires).toBe(3);
    expect(risk.criticalFires).toBe(3);
    expect(risk.score).toBe(66);
    expect(risk.level).toBe("high");
  });

  it("can reach extreme level with heavy activity", () => {
    const fires = Array.from({ length: 10 }, (_, i) => ({ ...baseReport, id: `r${i}`, severity: "critical" as const, status: "verified" as const }));
    const sats = Array.from({ length: 12 }, (_, i) => sat(`s${i}`));
    const risk = computeFireRisk(fires, sats, [wilaya("critical")], NOW);
    expect(risk.score).toBe(100);
    expect(risk.level).toBe("extreme");
    expect(risk.topWilayaNameAr).toBe("عنابة");
  });

  it("never exceeds 100", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...baseReport, id: `r${i}`, severity: "critical" as const }));
    const risk = computeFireRisk(many, [], [], NOW);
    expect(risk.score).toBeLessThanOrEqual(100);
  });

  // ------------------------
  // W-M8 unified freshness: the risk index obeys the SAME window as the
  // radar — stale incidents can no longer contradict a 0-target radar.
  // ------------------------

  it("excludes stale reports (older than 30 min) so risk cannot outlive the radar", () => {
    const stale = { ...baseReport, id: "old", timestamp: "2026-08-01T09:00:00Z" }; // 60 min old
    const risk = computeFireRisk([stale], [], [wilaya("safe")], NOW);
    expect(risk.activeFires).toBe(0);
    expect(risk.criticalFires).toBe(0);
    expect(risk.score).toBe(0);
    expect(risk.level).toBe("low");
  });

  it("excludes stale hotspots (scan older than 30 min)", () => {
    const stale = { ...sat("s"), scanTime: "2026-08-01T08:00:00Z" }; // 2 h old
    const risk = computeFireRisk([], [stale], [wilaya("safe")], NOW);
    expect(risk.liveHotspots).toBe(0);
    expect(risk.score).toBe(0);
  });

  it("accepts an incident right at the 30-minute boundary and rejects beyond it", () => {
    const edge = { ...baseReport, id: "edge", timestamp: "2026-08-01T09:30:00Z" }; // exactly 30 min
    expect(computeFireRisk([edge], [], [], NOW).activeFires).toBe(1);
    const late = { ...baseReport, id: "late", timestamp: "2026-08-01T09:29:59Z" }; // 30 min + 1 s
    expect(computeFireRisk([late], [], [], NOW).activeFires).toBe(0);
  });

  it("excludes reports materially from the future (beyond the 2-min skew)", () => {
    const future = { ...baseReport, id: "future", timestamp: "2026-08-01T10:30:00Z" }; // +30 min
    const risk = computeFireRisk([future], [], [wilaya("safe")], NOW);
    expect(risk.activeFires).toBe(0);
    expect(risk.score).toBe(0);
  });
});

describe("riskLevelFor", () => {
  it("maps score ranges to levels", () => {
    expect(riskLevelFor(10)).toBe("low");
    expect(riskLevelFor(30)).toBe("moderate");
    expect(riskLevelFor(60)).toBe("high");
    expect(riskLevelFor(90)).toBe("extreme");
    expect(riskLevelFor(100)).toBe("extreme");
    expect(riskLevelFor(0)).toBe("low");
  });
});