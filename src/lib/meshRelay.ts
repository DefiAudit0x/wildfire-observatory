/**
 * Mesh → Internet relay (store-and-forward gateway).
 *
 * When this device runs inside the Android WebView it receives decrypted
 * mesh messages via `window.AndroidBridge`. A report that originated on an
 * OFFLINE device can hop phone-to-phone (Nearby Connections) until it lands
 * on a device that HAS internet: this module verifies the attached
 * proof-of-work, deduplicates, and re-submits the report to /api/reports.
 *
 * Transient failures (offline, rate limit) go into a small localStorage queue
 * that is flushed when the connection returns.
 *
 * NOTE (protocol audit): E2EE broadcast is only decryptable by the peer the
 * sender addressed ("best peer"). Full any-to-any relay therefore requires
 * the protocol work tracked in ARCHITECTURE.md (peer key exchange + hybrid
 * encryption or signed-plaintext report envelope).
 */

import { onMeshMessage, verifyPoW } from "../utils/meshBridge";

interface MeshEnvelope {
  payload?: unknown;
  type?: string;
  lat?: unknown;
  lng?: unknown;
  ts?: unknown;
  powNonce?: unknown;
  powPrefix?: unknown;
  powDifficulty?: unknown;
}

const RELAY_QUEUE_KEY = "mesh_relay_queue";
const MAX_QUEUE = 50;
const MAX_SEEN_HASHES = 2000;
const seenRelayHashes = new Set<string>();
let flushInFlight: Promise<void> | null = null;

function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

interface QueuedRelay {
  id: string;
  report: Record<string, unknown>;
  ts: number;
}

function queueItemId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readQueue(): QueuedRelay[] {
  try {
    const raw = localStorage.getItem(RELAY_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is { report: Record<string, unknown>; ts?: unknown; id?: unknown } =>
        item && typeof item === "object" && item.report && typeof item.report === "object"
      )
      .map((item) => ({
        id: typeof item.id === "string" && item.id.length > 0
          ? item.id
          : hashString(JSON.stringify(item)),
        report: item.report,
        ts: typeof item.ts === "number" && Number.isFinite(item.ts) ? item.ts : Date.now(),
      }));
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedRelay[]): void {
  try {
    localStorage.setItem(RELAY_QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
  } catch {
    // storage unavailable — message lost, acceptable for a best-effort relay
  }
}

/**
 * Shape a received mesh report into a payload the server's report schema
 * accepts. Mirrors the server-side validation gates so garbage never reaches
 * the API.
 */
export function buildRelayedPayload(envelope: MeshEnvelope): Record<string, unknown> | null {
  if (typeof envelope.payload !== "string") return null;
  let payload: any;
  try {
    payload = JSON.parse(envelope.payload);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  const lat = Number(envelope.lat);
  const lng = Number(envelope.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const locationName = typeof payload.locationName === "string" ? payload.locationName.trim() : "";
  const wilaya = typeof payload.wilaya === "string" ? payload.wilaya.trim() : "";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  if (locationName.length < 3 || locationName.length > 200 ||
      wilaya.length < 3 || wilaya.length > 200 ||
      description.length < 10 || description.length > 2000) return null;

  if (payload.severity !== undefined &&
      !["low", "medium", "high", "critical"].includes(payload.severity)) return null;
  if (payload.reporterType !== undefined &&
      !["citizen", "volunteer", "official"].includes(payload.reporterType)) return null;

  const report: Record<string, unknown> = {
    lat,
    lng,
    locationName,
    wilaya,
    description,
    severity: payload.severity ?? "medium",
    reporterType: payload.reporterType ?? "citizen",
  };

  // The origin's client-generated id travels VERBATIM through the relay: the
  // server deduplicates on it, so a report that an online origin already
  // posted (or posts later) is never double-committed. Dropping it here would
  // break that idempotency contract.
  if (payload.clientGeneratedId !== undefined &&
      (typeof payload.clientGeneratedId !== "string" ||
       payload.clientGeneratedId.length < 8 || payload.clientGeneratedId.length > 64)) {
    return null;
  }
  if (typeof payload.clientGeneratedId === "string") {
    report.clientGeneratedId = payload.clientGeneratedId;
  }

  // The length and enum gates above mirror the server schema exactly.
  if (
    typeof report.locationName !== "string" ||
    typeof report.wilaya !== "string" ||
    typeof report.description !== "string"
  ) {
    return null;
  }
  return report;
}

async function submitRelay(report: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    // 409 = duplicate already known (the origin device posted it online) — fine.
    return res.status === 200 || res.status === 409;
  } catch {
    return false;
  }
}

async function handleRelayMessage(raw: string): Promise<void> {
  let envelope: MeshEnvelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return;
  }
  if (envelope.type !== "report") return;

  const powPrefix = typeof envelope.powPrefix === "string" ? envelope.powPrefix : "";
  const powNonce = typeof envelope.powNonce === "number" ? envelope.powNonce : -1;
  const powDifficulty = typeof envelope.powDifficulty === "number" ? envelope.powDifficulty : 0;
  if (!powPrefix || powNonce < 0 || powDifficulty < 1) return;

  // Anti-spam: drop messages that fail the attached proof-of-work.
  const powOk = await verifyPoW(powPrefix, powNonce, powDifficulty).catch(() => false);
  if (!powOk) return;

  // Anti-duplicate: the same gossip may arrive from several peers.
  const hash = hashString(raw);
  if (seenRelayHashes.has(hash)) return;
  if (seenRelayHashes.size > MAX_SEEN_HASHES) seenRelayHashes.clear();
  seenRelayHashes.add(hash);

  const report = buildRelayedPayload(envelope);
  if (!report) return;

  if (!(await submitRelay(report))) {
    enqueueRelay(report);
  }
}

export function enqueueRelay(report: Record<string, unknown>): void {
  const queue = readQueue();
  queue.push({ id: queueItemId(), report, ts: Date.now() });
  writeQueue(queue);
}

async function flushQueueInternal(): Promise<void> {
  const queue = readQueue();
  if (queue.length === 0) return;
  const processedIds = new Set<string>();
  const failedIds = new Set<string>();
  for (const item of queue) {
    if (await submitRelay(item.report)) processedIds.add(item.id);
    else failedIds.add(item.id);
  }

  if (processedIds.size === 0) return;

  // Re-read after awaits: enqueueRelay may have appended a newer item while
  // network submissions were in flight. Remove only the IDs from this flush;
  // never overwrite the newer snapshot with the stale pre-await queue.
  const latestQueue = readQueue();
  writeQueue(latestQueue.filter((item) => !processedIds.has(item.id) || failedIds.has(item.id)));
}

export function flushQueue(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = flushQueueInternal().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

let started = false;

/** Wire the relay once for the lifetime of the app (safe as a no-op in plain browsers). */
export function initMeshRelay(): void {
  if (started) return;
  started = true;

  onMeshMessage((message) => {
    void handleRelayMessage(message);
  });

  const flush = () => {
    void flushQueue();
  };
  window.addEventListener("online", flush);
  window.setInterval(flush, 60_000);
}
