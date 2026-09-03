import { Report, SatelliteHotspot } from "../types";

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  // ARC-M16 fix: the formula-injection guard used to prefix a leading "-" with
  // an apostrophe — corrupting every negative coordinate (Morocco's lng ≈
  // -13.0 became text "'-13.0" and the geometry silently broke downstream). A
  // plain numeric literal cannot be a spreadsheet formula, so numbers pass
  // through verbatim; the guard still applies to everything else.
  if (!/^-?\d+(?:\.\d+)?$/.test(text) && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reportsToCsv(reports: Report[]): string {
  const header = ["id", "lat", "lng", "wilaya", "severity", "status", "timestamp", "consensusCount", "description"];
  const rows = reports.map((r) =>
    [r.id, r.lat, r.lng, r.wilaya, r.severity, r.status, r.timestamp, r.consensusCount, r.description]
      .map(csvCell)
      .join(",")
  );
  return [header.join(","), ...rows].join("\r\n");
}

export function hotspotsToGeoJson(reports: Report[], satellites: SatelliteHotspot[]): string {
  const features = [
    ...reports.map((r) => ({
      type: "Feature",
      properties: {
        kind: "report",
        id: r.id,
        severity: r.severity,
        status: r.status,
        wilaya: r.wilaya,
        timestamp: r.timestamp,
      },
      geometry: { type: "Point", coordinates: [r.lng, r.lat] },
    })),
    ...satellites.map((s) => ({
      type: "Feature",
      properties: {
        kind: "satellite",
        id: s.id,
        confidence: s.confidence,
        satellite: s.satellite,
      },
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
    })),
  ];
  return JSON.stringify({ type: "FeatureCollection", features }, null, 2);
}