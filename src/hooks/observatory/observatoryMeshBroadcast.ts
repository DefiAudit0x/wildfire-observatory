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
 * v2.15.0 (audit — device first-claim): deviceId is REMOVED from the gossip
 * allow-list. Mesh peers are authenticated strangers, not trusted holders of
 * identity handles; leaking the id over the air was the one realistic
 * channel for racing a victim's notification-device binding.
 */
const MESH_REPORT_FIELDS = [
  "id", "clientGeneratedId", "lat", "lng", "locationName", "wilaya",
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

/** Fan-out of a report the SERVER accepted (its normalized copy, never PII). Returns whether the mesh accepted the broadcast. */
export function broadcastReportToMesh(reportLike: { lat?: unknown; lng?: unknown }): boolean {
  if (!isMeshSupported()) return false;
  try {
    const coords = guardedCoords(reportLike.lat, reportLike.lng);
    if (!coords) return false;
    // Mesh uses an allow-list: reporter name, phone, badge, image, and any
    // future form fields never cross the mesh boundary accidentally.
    const meshPayload = toMeshSafeReport(reportLike as Record<string, unknown>);
    const payload = JSON.stringify(meshPayload);
    // Fix 56b: broadcastMessage rejects plaintext above the 190 KiB mesh
    // ceiling — the server already holds this report, so the mesh copy is
    // best-effort gossip, but the rejection must not pass silently.
    // Fix 56c: the warning must not say "(oversize)" — broadcastMessage
    // also returns false for a PoW failure or a native error, and the
    // bridge carries no rejection reason; mislabeling those as oversize
    // would send troubleshooting toward payload size instead.
    if (!broadcastMessage(payload, "report", coords.lat, coords.lng)) {
      console.warn("Mesh broadcast rejected: report not fanned out", payload.length);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Mesh broadcast failed:", err);
    return false;
  }
}

/**
 * Fan-out for a report the server REJECTED or was unreachable: the content is
 * broadcast so an online gateway device can submit it to /api/reports
 * (meshRelay). The payload is shaped like a pending report — the same
 * contract receivers' gates enforce — and never carries PII.
 */
export function broadcastFailedReportToMesh(payload: CitizenReportPayload): boolean {
  if (!isMeshSupported()) return false;
  try {
    const coords = guardedCoords(payload.lat, payload.lng);
    if (!coords) return false;
    const pending = buildLocalPendingReport(payload);
    const meshPayload = toMeshSafeReport(pending as unknown as Record<string, unknown>);
    const meshJson = JSON.stringify(meshPayload);
    // Fix 56b: broadcastMessage rejects plaintext above the 190 KiB mesh
    // ceiling — for this path the mesh copy was the fallback delivery
    // route, so the rejection must not pass silently. The report content
    // itself survives in the user's offline draft; the caller already
    // surfaces the submission error.
    // Fix 56c: same as above — no "(oversize)" label; the bridge carries
    // no rejection reason, and a PoW failure or native error is not a
    // size rejection.
    if (!broadcastMessage(meshJson, "report", coords.lat, coords.lng)) {
      console.warn("Mesh broadcast rejected: failed report not fanned out", meshJson.length);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Mesh broadcast failed:", err);
    return false;
  }
}
