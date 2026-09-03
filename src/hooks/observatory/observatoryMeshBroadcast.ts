import { broadcastMessage, isMeshSupported } from "../../utils/meshBridge";
import type { CitizenReportPayload } from "./observatoryShared";
import { buildLocalPendingReport } from "./observatoryPendingReport";

/**
 * Pure mesh fan-out (ARC-H4): the two broadcast directions the observatory
 * uses, with the coordinate bounds gate and the PII allow-list kept together
 * so the contract can never drift apart between call sites.
 */

/**
 * Mesh fan-out for a report that reached the server: the SERVER's normalized
 * copy is broadcast (the receivers' isValidReport gate admits it), with PII
 * stripped. Coordinates that are not finite points inside physical bounds are
 * NEVER forwarded silently — a silent (0,0) mesh report would poison the map
 * on every peer.
 */
const MESH_REPORT_FIELDS = [
  "id", "clientGeneratedId", "deviceId", "lat", "lng", "locationName", "wilaya",
  "description", "severity", "status", "timestamp", "consensusCount",
] as const;

function toMeshSafeReport(reportLike: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(MESH_REPORT_FIELDS.filter((key) => reportLike[key] !== undefined).map((key) => [key, reportLike[key]]));
}

function guardedCoords(latLike: unknown, lngLike: unknown): { lat: number; lng: number } | null {
  const lat = Number(latLike);
  const lng = Number(lngLike);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    console.warn("Mesh broadcast skipped: invalid coordinates", latLike, lngLike);
    return null;
  }
  return { lat, lng };
}

/** Fan-out of a report the SERVER accepted (its normalized copy, never PII). */
export function broadcastReportToMesh(reportLike: { lat?: unknown; lng?: unknown }): void {
  if (!isMeshSupported()) return;
  try {
    const coords = guardedCoords(reportLike.lat, reportLike.lng);
    if (!coords) return;
    // Mesh uses an allow-list: reporter name, phone, badge, image, and any
    // future form fields never cross the mesh boundary accidentally.
    const meshPayload = toMeshSafeReport(reportLike as Record<string, unknown>);
    broadcastMessage(JSON.stringify(meshPayload), "report", coords.lat, coords.lng);
  } catch (err) {
    console.error("Mesh broadcast failed:", err);
  }
}

/**
 * Fan-out for a report the server REJECTED or was unreachable: the content is
 * broadcast so an online gateway device can submit it to /api/reports
 * (meshRelay). The payload is shaped like a pending report — the same
 * contract receivers' gates enforce — and never carries PII.
 */
export function broadcastFailedReportToMesh(payload: CitizenReportPayload): void {
  if (!isMeshSupported()) return;
  try {
    const coords = guardedCoords(payload.lat, payload.lng);
    if (!coords) return;
    const pending = buildLocalPendingReport(payload);
    const meshPayload = toMeshSafeReport(pending as unknown as Record<string, unknown>);
    broadcastMessage(JSON.stringify(meshPayload), "report", coords.lat, coords.lng);
  } catch (err) {
    console.error("Mesh broadcast failed:", err);
  }
}
