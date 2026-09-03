import { Report } from "../../types";
import { REPORT_STATUSES, REPORT_SEVERITIES } from "../../utils/datasetValidators";
import type { CitizenReportPayload } from "./observatoryShared";

/**
 * Pure report-status coercion — no hook state, no side effects (unit-tested
 * via tests/pending-report.test.ts).
 */

export const isReportStatus = (v: unknown): boolean =>
  typeof v === "string" && (REPORT_STATUSES as readonly string[]).includes(v);

export const isReportSeverity = (v: unknown): v is Report["severity"] =>
  typeof v === "string" && (REPORT_SEVERITIES as readonly string[]).includes(v);

/**
 * Display-safe local copy of a report the server accepted but whose response
 * was unreadable. Same fabrication the offline-draft path already uses: the
 * report IS committed server-side, the pending marker just reflects that this
 * device has not yet re-synced it. Coordinates that are not finite points are
 * NaN — never a silent (0,0) that would pin the report to the Gulf of Guinea
 * on the map.
 */
export function buildLocalPendingReport(payload: CitizenReportPayload): Report {
  const lat = Number(payload.lat);
  const lng = Number(payload.lng);
  return {
    id: payload.clientGeneratedId || `rep-local-${crypto.randomUUID()}`,
    lat: Number.isFinite(lat) ? lat : NaN,
    lng: Number.isFinite(lng) ? lng : NaN,
    locationName: payload.locationName,
    wilaya: payload.wilaya,
    description: payload.description,
    // Runtime guard (audit): the union type is compile-time only — the payload
    // arrives as DATA, so an out-of-schema severity is coerced to the schema's
    // default, never cast through a type assertion.
    severity: isReportSeverity(payload.severity) ? payload.severity : "medium",
    status: "pending" as const,
    timestamp: new Date().toISOString(),
    consensusCount: 1,
  };
}
