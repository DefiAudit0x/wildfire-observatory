import { Report, SatelliteHotspot } from "../types";

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  // M3 fix: neutralize spreadsheet formula injection. A cell beginning with
  // =, +, -, @, TAB or CR is executed as a formula by Excel/LibreOffice when
  // the export is opened (a known attack against official agencies that
  // consume these files). A leading apostrophe forces literal interpretation.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
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
        fallback: s.isFallback === true,
      },
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
    })),
  ];
  return JSON.stringify({ type: "FeatureCollection", features }, null, 2);
}