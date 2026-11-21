import { Report, SatelliteHotspot } from "../types";

// Fix 8b: exported so AdminPanel's CSV export can reuse the same formula
// guard as reportsToCsv instead of quoting without neutralization.
// Fix 8e: aligned with Fix 6's local guard (ADM-1) — the two differed and
// the merged tree proved it (9 operator-export tests failed): the trigger is
// now checked AFTER optional leading whitespace (a spreadsheet strips
// leading spaces/tabs before parsing a formula, so "  =1+1" is as dangerous
// as "=1+1"), and callers may force-quote a column (AdminPanel's text
// columns were always quoted by hand before Fix 6, and Fix 6's tests assert
// that shape). A plain numeric literal still passes through verbatim.
export function csvCell(value: unknown, quoted = false): string {
  let text = String(value ?? "");
  // ARC-M16 fix: the formula-injection guard used to prefix a leading "-" with
  // an apostrophe — corrupting every negative coordinate (Morocco's lng ≈
  // -13.0 became text "'-13.0" and the geometry silently broke downstream). A
  // plain numeric literal cannot be a spreadsheet formula, so numbers pass
  // through verbatim; the guard still applies to everything else.
  if (!/^-?\d+(?:\.\d+)?$/.test(text) && /^\s*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return quoted || /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reportsToCsv(reports: Report[]): string {
  const header = ["id", "lat", "lng", "wilaya", "severity", "status", "timestamp", "consensusCount", "description"];
  const rows = reports.map((r) =>
    [r.id, r.lat, r.lng, r.wilaya, r.severity, r.status, r.timestamp, r.consensusCount, r.description]
      .map((v) => csvCell(v))
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