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

import {
  isFreshMeshTimestamp,
  MESH_MESSAGE_CLOCK_SKEW_MS,
  MESH_MESSAGE_TTL_MS,
  NETWORK_POW_DIFFICULTY,
  onMeshMessage,
  verifyPoW,
} from "../utils/meshBridge";

export interface MeshEnvelope {
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
const RELAY_DB_NAME = "wildfire_observatory_mesh";
const RELAY_DB_VERSION = 1;
const RELAY_STORE_NAME = "relay_queue";
const MAX_QUEUE = 50;
const MAX_SEEN_HASHES = 2000;
export const RELAY_REPLAY_RETENTION_MS = MESH_MESSAGE_TTL_MS + MESH_MESSAGE_CLOCK_SKEW_MS;
export const RELAY_MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000;
export const RELAY_MAX_QUEUE_ATTEMPTS = 8;
export const RELAY_BASE_RETRY_BACKOFF_MS = 60 * 1000;
export const RELAY_MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const TERMINAL_DUPLICATE_CODES = new Set([
  "DUPLICATE_CLIENT_GENERATED_ID",
  "DUPLICATE_SPATIAL_REPORT",
]);
const seenRelayHashes = new Map<string, number>();
let relayDbPromise: Promise<IDBDatabase | null> | null = null;
let volatileQueue: QueuedRelay[] = [];
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
  attempts: number;
  nextAttemptAt: number;
  deadLetter?: boolean;
  lastError?: string;
}

function queueItemId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeQueueItem(item: {
  report: Record<string, unknown>;
  ts?: unknown;
  id?: unknown;
  attempts?: unknown;
  nextAttemptAt?: unknown;
  deadLetter?: unknown;
  lastError?: unknown;
}): QueuedRelay {
  const now = Date.now();
  return {
    id: typeof item.id === "string" && item.id.length > 0 ? item.id : hashString(JSON.stringify(item)),
    report: item.report,
    ts: typeof item.ts === "number" && Number.isFinite(item.ts) ? item.ts : now,
    attempts: typeof item.attempts === "number" && Number.isInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0,
    nextAttemptAt: typeof item.nextAttemptAt === "number" && Number.isFinite(item.nextAttemptAt) ? item.nextAttemptAt : now,
    deadLetter: item.deadLetter === true,
    lastError: typeof item.lastError === "string" ? item.lastError : undefined,
  };
}

function normalizeQueue(value: unknown): QueuedRelay[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is {
      report: Record<string, unknown>;
      ts?: unknown;
      id?: unknown;
      attempts?: unknown;
      nextAttemptAt?: unknown;
      deadLetter?: unknown;
      lastError?: unknown;
    } => item && typeof item === "object" && "report" in item && !!item.report && typeof item.report === "object")
    .map(normalizeQueueItem);
}

function mergeVolatileQueue(queue: QueuedRelay[]): QueuedRelay[] {
  const byId = new Map(queue.map((item) => [item.id, item]));
  for (const item of volatileQueue) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function readLocalQueue(): QueuedRelay[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(RELAY_QUEUE_KEY);
    return normalizeQueue(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function writeLocalQueue(queue: QueuedRelay[]): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(RELAY_QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
    return true;
  } catch {
    return false;
  }
}

function openRelayDb(): Promise<IDBDatabase | null> {
  if (typeof globalThis.indexedDB === "undefined") return Promise.resolve(null);
  if (relayDbPromise) return relayDbPromise;
  relayDbPromise = new Promise((resolve) => {
    let settled = false;
    const fallbackTimer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 100);
    try {
      const request = globalThis.indexedDB.open(RELAY_DB_NAME, RELAY_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(RELAY_STORE_NAME)) {
          request.result.createObjectStore(RELAY_STORE_NAME);
        }
      };
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(request.result);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(null);
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(null);
      };
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(null);
      }
    }
  });
  return relayDbPromise;
}

async function readIndexedQueue(db: IDBDatabase): Promise<QueuedRelay[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const fallbackTimer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 100);
    try {
      const request = db.transaction(RELAY_STORE_NAME, "readonly").objectStore(RELAY_STORE_NAME).get("items");
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(normalizeQueue(request.result));
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(null);
      };
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(null);
      }
    }
  });
}

async function writeIndexedQueue(db: IDBDatabase, queue: QueuedRelay[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const fallbackTimer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, 100);
    try {
      const request = db.transaction(RELAY_STORE_NAME, "readwrite").objectStore(RELAY_STORE_NAME).put(queue.slice(-MAX_QUEUE), "items");
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(true);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(false);
      };
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve(false);
      }
    }
  });
}

async function readQueue(): Promise<QueuedRelay[]> {
  const db = await openRelayDb();
  if (db) {
    const indexed = await readIndexedQueue(db);
    if (indexed !== null) {
      if (indexed.length === 0) {
        const legacy = readLocalQueue();
        if (legacy.length > 0) await writeIndexedQueue(db, legacy);
        return mergeVolatileQueue(legacy);
      }
      return mergeVolatileQueue(indexed);
    }
  }
  return mergeVolatileQueue(readLocalQueue());
}

async function writeQueue(queue: QueuedRelay[]): Promise<boolean> {
  const bounded = queue.slice(-MAX_QUEUE);
  const db = await openRelayDb();
  if (db && await writeIndexedQueue(db, bounded)) {
    volatileQueue = [];
    return true;
  }
  if (writeLocalQueue(bounded)) {
    volatileQueue = [];
    return true;
  }
  console.error("[MeshRelay] Queue persistence unavailable; retaining item in memory only");
  return false;
}

function pruneSeenRelayHashes(now: number): void {
  const cutoff = now - RELAY_REPLAY_RETENTION_MS;
  for (const [hash, recordedAt] of seenRelayHashes) {
    if (recordedAt <= cutoff) seenRelayHashes.delete(hash);
  }
}

export function checkAndRecordRelayHash(raw: string, now = Date.now()): boolean {
  pruneSeenRelayHashes(now);
  const hash = hashString(raw);
  const recordedAt = seenRelayHashes.get(hash);
  if (recordedAt !== undefined && now - recordedAt <= RELAY_REPLAY_RETENTION_MS) return false;
  // Fail closed while the freshness window is still populated. Evicting a
  // fresh entry would turn bounded memory into a replay bypass under flooding.
  if (seenRelayHashes.size >= MAX_SEEN_HASHES) return false;
  seenRelayHashes.set(hash, now);
  return true;
}

export function isRelayEnvelopeAdmissible(envelope: MeshEnvelope, now = Date.now()): boolean {
  const powPrefix = typeof envelope.powPrefix === "string" ? envelope.powPrefix : "";
  const powNonce = typeof envelope.powNonce === "number" ? envelope.powNonce : -1;
  const powDifficulty = typeof envelope.powDifficulty === "number" ? envelope.powDifficulty : 0;
  return envelope.type === "report" &&
    powPrefix.length > 0 &&
    Number.isInteger(powNonce) && powNonce >= 0 &&
    powDifficulty === NETWORK_POW_DIFFICULTY &&
    typeof envelope.ts === "number" &&
    isFreshMeshTimestamp(envelope.ts, now);
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

export async function submitRelay(report: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    if (res.status === 200) return true;
    if (res.status !== 409) return false;
    const body = await res.json().catch(() => null) as { code?: unknown } | null;
    return typeof body?.code === "string" && TERMINAL_DUPLICATE_CODES.has(body.code);
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
  if (!isRelayEnvelopeAdmissible(envelope)) return;

  // Anti-spam: drop messages that fail the attached proof-of-work.
  const powOk = await verifyPoW(powPrefix, powNonce, powDifficulty).catch(() => false);
  if (!powOk) return;

  // Anti-duplicate: the same gossip may arrive from several peers.
  if (!checkAndRecordRelayHash(raw)) return;

  const report = buildRelayedPayload(envelope);
  if (!report) return;

  if (!(await submitRelay(report))) {
    void enqueueRelay(report);
  }
}

export async function enqueueRelay(report: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  const item = { id: queueItemId(), report, ts: now, attempts: 0, nextAttemptAt: now } satisfies QueuedRelay;
  const queue = await readQueue();
  queue.push(item);
  if (!(await writeQueue(queue))) volatileQueue.push(item);
}

async function flushQueueInternal(): Promise<void> {
  const now = Date.now();
  const queue = await readQueue();
  if (queue.length === 0) return;
  const processedIds = new Set<string>();
  const updatedItems = new Map<string, QueuedRelay>();
  let changed = false;
  for (const item of queue) {
    if (item.deadLetter) continue;
    if (now - item.ts >= RELAY_MAX_QUEUE_AGE_MS) {
      updatedItems.set(item.id, { ...item, deadLetter: true, lastError: "expired" });
      changed = true;
      continue;
    }
    if (item.nextAttemptAt > now) continue;
    if (await submitRelay(item.report)) {
      processedIds.add(item.id);
      changed = true;
      continue;
    }
    const attempts = item.attempts + 1;
    const deadLetter = attempts >= RELAY_MAX_QUEUE_ATTEMPTS;
    const backoff = Math.min(RELAY_BASE_RETRY_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), RELAY_MAX_RETRY_BACKOFF_MS);
    updatedItems.set(item.id, {
      ...item,
      attempts,
      nextAttemptAt: now + backoff,
      deadLetter,
      lastError: "submission failed",
    });
    changed = true;
  }

  if (!changed) return;

  // Re-read after awaits: enqueueRelay may have appended a newer item while
  // network submissions were in flight. Remove only the IDs from this flush;
  // never overwrite the newer snapshot with the stale pre-await queue.
  const latestQueue = await readQueue();
  const nextQueue = latestQueue
    .filter((item) => !processedIds.has(item.id))
    .map((item) => updatedItems.get(item.id) ?? item);
  if (!(await writeQueue(nextQueue))) volatileQueue = nextQueue;
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
