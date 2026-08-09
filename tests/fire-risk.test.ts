import { describe, it, expect } from "vitest";
import { computeFireRisk, riskLevelFor } from "../src/utils/fireRisk";
import type { Report, SatelliteHotspot, WilayaStatus } from "../src/types";

const baseReport: Report = {
  id: "r",
  lat: 36.7,
  lng: 7.6,
  locationName: "x",
  wilaya: "الجزائر - عنابة (Algérie - Annaba)",
  description: "x",
  severity: "medium",
  status: "pending",
  timestamp: "2026-08-01T10:00:00Z",
  consensusCount: 0,
};

const sat = (id: string, fallback = false): SatelliteHotspot => ({
  id,
  lat: 36.8,
  lng: 7.7,
  brightness: 320,
  confidence: 80,
  scanTime: "2026-08-01T00:00:00Z",
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
    const risk = computeFireRisk([], [], [wilaya("safe")]);
    expect(risk.score).toBe(0);
    expect(risk.level).toBe("low");
  });

  it("ignores resolved reports and fallback hotspots", () => {
    const resolved = { ...baseReport, status: "resolved" as const, severity: "critical" as const };
    const risk = computeFireRisk([resolved], [sat("s", true)], [wilaya("safe")]);
    expect(risk.score).toBe(0);
    expect(risk.activeFires).toBe(0);
  });

  it("escalates with critical fires (high level)", () => {
    const criticals = [0, 1, 2].map((i) => ({ ...baseReport, id: `r${i}`, severity: "critical" as const }));
    const risk = computeFireRisk(criticals, [sat("s1"), sat("s2"), sat("s3")], [wilaya("safe")]);
    expect(risk.activeFires).toBe(3);
    expect(risk.criticalFires).toBe(3);
    expect(risk.score).toBe(66);
    expect(risk.level).toBe("high");
  });

  it("can reach extreme level with heavy activity", () => {
    const fires = Array.from({ length: 10 }, (_, i) => ({ ...baseReport, id: `r${i}`, severity: "critical" as const, status: "verified" as const }));
    const sats = Array.from({ length: 12 }, (_, i) => sat(`s${i}`));
    const risk = computeFireRisk(fires, sats, [wilaya("critical")]);
    expect(risk.score).toBe(100);
    expect(risk.level).toBe("extreme");
    expect(risk.topWilayaNameAr).toBe("عنابة");
  });

  it("never exceeds 100", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...baseReport, id: `r${i}`, severity: "critical" as const }));
    const risk = computeFireRisk(many, [], []);
    expect(risk.score).toBeLessThanOrEqual(100);
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