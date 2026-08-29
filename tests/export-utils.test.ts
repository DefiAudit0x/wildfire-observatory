import { describe, it, expect } from "vitest";
import { reportsToCsv, hotspotsToGeoJson } from "../src/utils/export";
import type { Report, SatelliteHotspot } from "../src/types";

const report: Report = {
  id: "r1",
  lat: 36.7,
  lng: 7.6,
  locationName: "الغابة",
  wilaya: "الجزائر - عنابة (Algérie - Annaba)",
  description: 'نار قوية، "خطيرة" جداً',
  severity: "high",
  status: "pending",
  timestamp: "2026-08-01T10:00:00Z",
  consensusCount: 3,
};

const satellite: SatelliteHotspot = {
  id: "s1",
  lat: 36.8,
  lng: 7.7,
  brightness: 320.5,
  confidence: 90,
  scanTime: "2026-08-01T00:00:00Z",
  satellite: "VIIRS",
  wilaya: "الجزائر - عنابة (Algérie - Annaba)",
  isFallback: false,
};

describe("reportsToCsv", () => {
  it("writes a header row plus one row per report", () => {
    const csv = reportsToCsv([report]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("id,lat,lng,wilaya,severity,status,timestamp,consensusCount,description");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("r1");
    expect(lines[1]).toContain("36.7");
  });

  it("escapes commas and double quotes inside cells", () => {
    const csv = reportsToCsv([report]);
    expect(csv).toContain('"نار قوية، ""خطيرة"" جداً"');
  });

  it("neutralizes spreadsheet formula injection with a leading apostrophe (M3)", () => {
    const base = { ...report };
    const csv = reportsToCsv([
      report,
      { ...base, id: "r2", description: "=HYPERLINK(\"http://evil.example\",\"نفّذ\")" },
      { ...base, id: "r3", description: "+cmd|'/C calc'!A0" },
      { ...base, id: "r4", description: "@SUM(1+1)" },
    ]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'@SUM");
    // Regular descriptions stay untouched
    expect(csv).toContain('"نار قوية، ""خطيرة"" جداً"');
  });

  it("handles empty input with just the header", () => {
    const csv = reportsToCsv([]);
    expect(csv.split("\r\n")).toHaveLength(1);
  });
});

describe("hotspotsToGeoJson", () => {
  it("builds a FeatureCollection with report and satellite points", () => {
    const parsed = JSON.parse(hotspotsToGeoJson([report], [satellite])) as any;
    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].geometry.type).toBe("Point");
    expect(parsed.features[0].geometry.coordinates).toEqual([7.6, 36.7]);
    expect(parsed.features[1].properties.kind).toBe("satellite");
    expect(parsed.features[1].properties.satellite).toBe("VIIRS");
    expect(parsed.features[1].properties.fallback).toBe(false);
  });

  it("flags fallback satellite points", () => {
    const fallback: SatelliteHotspot = { ...satellite, isFallback: true };
    const parsed = JSON.parse(hotspotsToGeoJson([], [fallback])) as any;
    expect(parsed.features[0].properties.fallback).toBe(true);
  });
});