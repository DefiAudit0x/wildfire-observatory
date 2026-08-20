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
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

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
type ReplayReservation = { hash: string; token: string };
const seenRelayHashes = new Map<string, { recordedAt: number; token: string }>();
let replayReservationSequence = 0;
let relayDbPromise: Promise<IDBDatabase | null> | null = null;
let indexedDbDisabledForSession = false;
let volatilePending: QueuedRelay[] = [];
let volatilePendingIsAuthoritative = false;
let flushInFlight: Promise<void> | null = null;
let queueMutationTail: Promise<void> = Promise.resolve();
let queueRevision = 0;

function legacyContentFingerprint(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

export function relayReplayDigest(raw: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(raw)));
}

interface QueuedRelay {
  id: string;
  report: Record<string, unknown>;
  ts: number;
  attempts: number;
  nextAttemptAt: number;
  deadLetter?: boolean;
  deadLetteredAt?: number;
  lastError?: string;
}

type RelayJournalState = "prepared" | "delivered" | "committed";
type RelayDeliveryDisposition = "http_200" | "terminal_duplicate";

interface RelayJournalEntry {
  journalId: string;
  queueItemId: string;
  storageReplica: "co_located";
  baseQueueRevision: number;
  clientGeneratedId: string;
  reportFingerprint: string;
  report: Record<string, unknown>;
  state: RelayJournalState;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  deliveryDisposition?: RelayDeliveryDisposition;
}

interface RelayQueueState {
  revision: number;
  pending: QueuedRelay[];
  deadLetters: QueuedRelay[];
  journal: RelayJournalEntry[];
}

export type RelayEnqueueResult =
  | { accepted: true; storage: "persistent" | "volatile" }
  | { accepted: false; reason: "dead_letter_unavailable" | "queue_capacity_protected" | "missing_origin_client_generated_id" };

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
  deadLetteredAt?: unknown;
  lastError?: unknown;
}): QueuedRelay {
  const now = Date.now();
  return {
    id: typeof item.id === "string" && item.id.length > 0 ? item.id : legacyContentFingerprint(JSON.stringify(item)),
    report: item.report,
    ts: typeof item.ts === "number" && Number.isFinite(item.ts) ? item.ts : now,
    attempts: typeof item.attempts === "number" && Number.isInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0,
    nextAttemptAt: typeof item.nextAttemptAt === "number" && Number.isFinite(item.nextAttemptAt) ? item.nextAttemptAt : now,
    deadLetter: item.deadLetter === true,
    deadLetteredAt: typeof item.deadLetteredAt === "number" && Number.isFinite(item.deadLetteredAt) ? item.deadLetteredAt : undefined,
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
      deadLetteredAt?: unknown;
      lastError?: unknown;
    } => item && typeof item === "object" && "report" in item && !!item.report && typeof item.report === "object")
    .map(normalizeQueueItem);
}

function splitLegacyQueue(items: QueuedRelay[]): Pick<RelayQueueState, "pending" | "deadLetters"> {
  return {
    pending: items.filter((item) => !item.deadLetter),
    deadLetters: items.filter((item) => item.deadLetter),
  };
}

function normalizeJournal(value: unknown): RelayJournalEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, RelayJournalEntry>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Partial<RelayJournalEntry>;
    if (
      typeof entry.journalId !== "string" ||
      typeof entry.queueItemId !== "string" ||
      typeof entry.clientGeneratedId !== "string" ||
      entry.clientGeneratedId.length < 8 ||
      entry.clientGeneratedId.length > 64 ||
      typeof entry.reportFingerprint !== "string" ||
      !entry.report || typeof entry.report !== "object" ||
      !["prepared", "delivered", "committed"].includes(entry.state ?? "") ||
      typeof entry.createdAt !== "number" ||
      typeof entry.updatedAt !== "number" ||
      typeof entry.baseQueueRevision !== "number"
    ) continue;
    entries.set(entry.queueItemId, {
      journalId: entry.journalId,
      queueItemId: entry.queueItemId,
      storageReplica: "co_located",
      baseQueueRevision: entry.baseQueueRevision,
      clientGeneratedId: entry.clientGeneratedId,
      reportFingerprint: entry.reportFingerprint,
      report: entry.report as Record<string, unknown>,
      state: entry.state as RelayJournalState,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      deliveredAt: typeof entry.deliveredAt === "number" ? entry.deliveredAt : undefined,
      deliveryDisposition: entry.deliveryDisposition === "http_200" || entry.deliveryDisposition === "terminal_duplicate"
        ? entry.deliveryDisposition
        : undefined,
    });
  }
  return [...entries.values()];
}

function normalizeRelayQueueState(value: unknown): RelayQueueState {
  if (Array.isArray(value)) return { revision: 0, ...splitLegacyQueue(normalizeQueue(value)), journal: [] };
  if (!value || typeof value !== "object") return { revision: 0, pending: [], deadLetters: [], journal: [] };
  const snapshot = value as { revision?: unknown; items?: unknown; pending?: unknown; deadLetters?: unknown; journal?: unknown };
  const revision = typeof snapshot.revision === "number" && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0
    ? snapshot.revision
    : 0;
  if (snapshot.pending !== undefined || snapshot.deadLetters !== undefined) {
    return {
      revision,
      pending: normalizeQueue(snapshot.pending),
      deadLetters: normalizeQueue(snapshot.deadLetters),
      journal: normalizeJournal(snapshot.journal),
    };
  }
  return { revision, ...splitLegacyQueue(normalizeQueue(snapshot.items)), journal: normalizeJournal(snapshot.journal) };
}

function journalStateRank(state: RelayJournalState): number {
  return state === "committed" ? 3 : state === "delivered" ? 2 : 1;
}

function mergeJournalEntries(...states: RelayQueueState[]): RelayJournalEntry[] {
  const merged = new Map<string, RelayJournalEntry>();
  for (const state of states) {
    for (const candidate of state.journal) {
      const existing = merged.get(candidate.queueItemId);
      if (!existing) {
        merged.set(candidate.queueItemId, candidate);
        continue;
      }
      const candidateRank = journalStateRank(candidate.state);
      const existingRank = journalStateRank(existing.state);
      if (
        candidateRank > existingRank ||
        (candidateRank === existingRank && (
          candidate.updatedAt > existing.updatedAt ||
          (candidate.updatedAt === existing.updatedAt && candidate.baseQueueRevision > existing.baseQueueRevision)
        ))
      ) {
        merged.set(candidate.queueItemId, candidate);
      }
    }
  }
  return [...merged.values()];
}

function mergeReplicaQueueStates(local: RelayQueueState, indexed: RelayQueueState): RelayQueueState {
  const mergedJournal = mergeJournalEntries(local, indexed);
  if (mergedJournal.length === 0) {
    const selected = indexed.revision >= local.revision ? indexed : local;
    return rebuildPendingFromJournal(selected);
  }

  const pendingById = new Map<string, { item: QueuedRelay; revision: number }>();
  const deadLetterById = new Map<string, { item: QueuedRelay; revision: number }>();

  for (const state of [local, indexed]) {
    for (const item of state.pending) {
      const existing = pendingById.get(item.id);
      if (!existing || state.revision > existing.revision || (state.revision === existing.revision && item.ts > existing.item.ts)) {
        pendingById.set(item.id, { item, revision: state.revision });
      }
    }
    for (const item of state.deadLetters) {
      const existing = deadLetterById.get(item.id);
      if (!existing || state.revision > existing.revision || (state.revision === existing.revision && item.ts > existing.item.ts)) {
        deadLetterById.set(item.id, { item, revision: state.revision });
      }
    }
  }

  const terminalIds = new Set(
    mergedJournal
      .filter((entry) => entry.state === "delivered" || entry.state === "committed")
      .map((entry) => entry.queueItemId),
  );
  const deadLetterIds = new Set(deadLetterById.keys());
  const pending = [...pendingById.values()]
    .filter(({ item }) => !terminalIds.has(item.id) && !deadLetterIds.has(item.id))
    .map(({ item }) => item);

  return {
    revision: Math.max(local.revision, indexed.revision),
    pending,
    deadLetters: [...deadLetterById.values()].map(({ item }) => item),
    journal: mergedJournal,
  };
}

function isValidClientGeneratedId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 64;
}

function journalMatchesItem(entry: RelayJournalEntry, item: QueuedRelay): boolean {
  return entry.queueItemId === item.id &&
    entry.clientGeneratedId === item.report.clientGeneratedId &&
    entry.reportFingerprint === legacyContentFingerprint(JSON.stringify(item.report));
}

function rebuildPendingFromJournal(state: RelayQueueState): RelayQueueState {
  const outcomes = new Set(
    state.journal
      .filter((entry) => entry.state === "delivered" || entry.state === "committed")
      .map((entry) => entry.queueItemId),
  );
  if (outcomes.size === 0) return state;
  return {
    ...state,
    pending: state.pending.filter((item) => !outcomes.has(item.id)),
  };
}

function upsertJournalEntry(entries: RelayJournalEntry[], entry: RelayJournalEntry): RelayJournalEntry[] {
  return [...entries.filter((existing) => existing.queueItemId !== entry.queueItemId), entry];
}

function prepareJournalEntry(item: QueuedRelay, baseQueueRevision: number): RelayJournalEntry {
  const now = Date.now();
  const clientGeneratedId = item.report.clientGeneratedId as string;
  return {
    journalId: `journal-${item.id}`,
    queueItemId: item.id,
    storageReplica: "co_located",
    baseQueueRevision,
    clientGeneratedId,
    reportFingerprint: legacyContentFingerprint(JSON.stringify(item.report)),
    report: item.report,
    state: "prepared",
    createdAt: now,
    updatedAt: now,
  };
}

function markJournalDelivered(
  entries: RelayJournalEntry[],
  item: QueuedRelay,
  disposition: RelayDeliveryDisposition
): RelayJournalEntry[] {
  const existing = entries.find((entry) => entry.queueItemId === item.id);
  if (!existing) return entries;
  const now = Date.now();
  return upsertJournalEntry(entries, {
    ...existing,
    state: "delivered",
    updatedAt: now,
    deliveredAt: now,
    deliveryDisposition: disposition,
  });
}

function commitDeliveredJournal(entries: RelayJournalEntry[], pending: QueuedRelay[]): RelayJournalEntry[] {
  const now = Date.now();
  return entries.map((entry) => {
    if (entry.state !== "delivered" || pending.some((item) => journalMatchesItem(entry, item))) return entry;
    return { ...entry, state: "committed", updatedAt: now };
  });
}

function mergeVolatilePending(pending: QueuedRelay[]): QueuedRelay[] {
  const durablePending = volatilePendingIsAuthoritative ? [] : pending;
  const byId = new Map(durablePending.map((item) => [item.id, item]));
  for (const item of volatilePending) byId.set(item.id, item);
  return [...byId.values()];
}

function readLocalQueueState(): RelayQueueState {
  try {
    if (typeof localStorage === "undefined") return { revision: 0, pending: [], deadLetters: [], journal: [] };
    const raw = localStorage.getItem(RELAY_QUEUE_KEY);
    return normalizeRelayQueueState(raw ? JSON.parse(raw) : []);
  } catch {
    return { revision: 0, pending: [], deadLetters: [], journal: [] };
  }
}

function writeLocalQueueState(state: RelayQueueState): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(RELAY_QUEUE_KEY, JSON.stringify({
      revision: state.revision,
      pending: state.pending,
      deadLetters: state.deadLetters,
      journal: state.journal,
    }));
    return true;
  } catch {
    return false;
  }
}

function openRelayDb(): Promise<IDBDatabase | null> {
  if (indexedDbDisabledForSession || typeof globalThis.indexedDB === "undefined") return Promise.resolve(null);
  if (relayDbPromise) return relayDbPromise;
  relayDbPromise = new Promise((resolve) => {
    let settled = false;
    const fallbackTimer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        indexedDbDisabledForSession = true;
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

async function readIndexedQueueState(db: IDBDatabase): Promise<RelayQueueState | null> {
  return new Promise((resolve) => {
    let settled = false;
    const fallbackTimer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 100);
    try {
      const store = db.transaction(RELAY_STORE_NAME, "readonly").objectStore(RELAY_STORE_NAME);
      const request = store.get("state");
      request.onsuccess = () => {
        if (settled) return;
        if (request.result !== undefined) {
          settled = true;
          globalThis.clearTimeout(fallbackTimer);
          resolve(normalizeRelayQueueState(request.result));
          return;
        }
        const legacyRequest = store.get("items");
        legacyRequest.onsuccess = () => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(fallbackTimer);
          resolve(normalizeRelayQueueState(legacyRequest.result));
        };
        legacyRequest.onerror = () => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(fallbackTimer);
          resolve(null);
        };
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

async function writeIndexedQueue(
  db: IDBDatabase,
  state: RelayQueueState
): Promise<"written" | "failed" | "timedOut"> {
  return new Promise((resolve) => {
    let settled = false;
    let transaction: IDBTransaction | null = null;
    const fallbackTimer = globalThis.setTimeout(() => {
      if (settled) return;
      if (!transaction) {
        settled = true;
        resolve("failed");
        return;
      }
      try {
        transaction.abort();
      } catch {
        return;
      }
      if (settled) return;
      settled = true;
      resolve("timedOut");
    }, 100);
    try {
      transaction = db.transaction(RELAY_STORE_NAME, "readwrite");
      const request = transaction.objectStore(RELAY_STORE_NAME).put(state, "state");
      request.onsuccess = () => {};
      request.onerror = () => {};
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve("written");
      };
      const failTransaction = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve("failed");
      };
      transaction.onabort = failTransaction;
      transaction.onerror = failTransaction;
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(fallbackTimer);
        resolve("failed");
      }
    }
  });
}

async function readRelayQueueState(): Promise<RelayQueueState> {
  const local = rebuildPendingFromJournal(readLocalQueueState());
  queueRevision = Math.max(queueRevision, local.revision);
  const db = await openRelayDb();
  if (db) {
    const indexed = await readIndexedQueueState(db);
    if (indexed !== null) {
      const merged = mergeReplicaQueueStates(local, indexed);
      const selected = rebuildPendingFromJournal({
        ...merged,
        pending: mergeVolatilePending(merged.pending),
      });
      queueRevision = Math.max(queueRevision, selected.revision);
      return selected;
    }
  }
  return rebuildPendingFromJournal({
    ...local,
    pending: mergeVolatilePending(local.pending),
  });
}

async function writeRelayQueueState(state: Omit<RelayQueueState, "revision">): Promise<"persistent" | "failed"> {
  const snapshot = {
    revision: queueRevision + 1,
    pending: state.pending,
    deadLetters: state.deadLetters,
    journal: state.journal,
  } satisfies RelayQueueState;
  const db = await openRelayDb();
  if (db) {
    const result = await writeIndexedQueue(db, snapshot);
    if (result === "written") {
      queueRevision = snapshot.revision;
      writeLocalQueueState(snapshot);
      volatilePending = [];
      volatilePendingIsAuthoritative = false;
      return "persistent";
    }
    if (result === "timedOut") indexedDbDisabledForSession = true;
  }
  if (writeLocalQueueState(snapshot)) {
    queueRevision = snapshot.revision;
    volatilePending = [];
    volatilePendingIsAuthoritative = false;
    return "persistent";
  }
  return "failed";
}

function makeCapacityTransition(state: RelayQueueState, item: QueuedRelay, now: number): {
  pending: QueuedRelay[];
  deadLetters: QueuedRelay[];
  journal: RelayJournalEntry[];
  requiresDlq: boolean;
  capacityProtected: boolean;
} {
  if (state.pending.length < MAX_QUEUE) {
    return {
      pending: [...state.pending, item],
      deadLetters: state.deadLetters,
      journal: state.journal,
      requiresDlq: false,
      capacityProtected: false,
    };
  }

  const protectedIds = new Set(
    state.journal
      .filter((entry) => entry.state === "prepared" || entry.state === "delivered")
      .map((entry) => entry.queueItemId),
  );
  const oldestEvictable = [...state.pending]
    .filter((candidate) => !protectedIds.has(candidate.id))
    .sort((a, b) => a.ts - b.ts)[0];
  if (!oldestEvictable) {
    return {
      pending: state.pending,
      deadLetters: state.deadLetters,
      journal: state.journal,
      requiresDlq: false,
      capacityProtected: true,
    };
  }

  return {
    pending: state.pending.filter((candidate) => candidate.id !== oldestEvictable.id).concat(item),
    deadLetters: [...state.deadLetters, {
      ...oldestEvictable,
      deadLetter: true,
      deadLetteredAt: now,
      lastError: "capacity_exceeded",
    }],
    journal: state.journal,
    requiresDlq: true,
    capacityProtected: false,
  };
}

function serializeQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = queueMutationTail.then(operation, operation);
  queueMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function pruneSeenRelayHashes(now: number): void {
  const cutoff = now - RELAY_REPLAY_RETENTION_MS;
  for (const [hash, reservation] of seenRelayHashes) {
    if (reservation.recordedAt <= cutoff) seenRelayHashes.delete(hash);
  }
}

export function reserveRelayHash(raw: string, now = Date.now()): ReplayReservation | null {
  pruneSeenRelayHashes(now);
  const hash = relayReplayDigest(raw);
  const existing = seenRelayHashes.get(hash);
  if (existing !== undefined && now - existing.recordedAt <= RELAY_REPLAY_RETENTION_MS) return null;
  if (seenRelayHashes.size >= MAX_SEEN_HASHES) return null;
  const reservation = { hash, token: `${now}-${++replayReservationSequence}` };
  seenRelayHashes.set(hash, { recordedAt: now, token: reservation.token });
  return reservation;
}

export function releaseRelayHash(reservation: ReplayReservation): void {
  if (seenRelayHashes.get(reservation.hash)?.token === reservation.token) {
    seenRelayHashes.delete(reservation.hash);
  }
}

export function checkAndRecordRelayHash(raw: string, now = Date.now()): boolean {
  return reserveRelayHash(raw, now) !== null;
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

export function buildRelayedPayload(envelope: MeshEnvelope): Record<string, unknown> | null {
  if (typeof envelope.payload !== "string") return null;
  let payload: any;
  try { payload = JSON.parse(envelope.payload); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;
  const lat = Number(envelope.lat);
  const lng = Number(envelope.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const locationName = typeof payload.locationName === "string" ? payload.locationName.trim() : "";
  const wilaya = typeof payload.wilaya === "string" ? payload.wilaya.trim() : "";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  if (locationName.length < 3 || locationName.length > 200 || wilaya.length < 3 || wilaya.length > 200 || description.length < 10 || description.length > 2000) return null;
  if (payload.severity !== undefined && !["low", "medium", "high", "critical"].includes(payload.severity)) return null;
  if (payload.reporterType !== undefined && !["citizen", "volunteer", "official"].includes(payload.reporterType)) return null;
  const report: Record<string, unknown> = {
    lat, lng, locationName, wilaya, description,
    severity: payload.severity ?? "medium",
    reporterType: payload.reporterType ?? "citizen",
  };
  if (!isValidClientGeneratedId(payload.clientGeneratedId)) return null;
  report.clientGeneratedId = payload.clientGeneratedId;
  return report;
}

async function submitRelayOutcome(report: Record<string, unknown>): Promise<RelayDeliveryDisposition | null> {
  try {
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    if (res.status === 200) return "http_200";
    if (res.status !== 409) return null;
    const body = await res.json().catch(() => null) as { code?: unknown } | null;
    return typeof body?.code === "string" && TERMINAL_DUPLICATE_CODES.has(body.code) ? "terminal_duplicate" : null;
  } catch { return null; }
}

export async function submitRelay(report: Record<string, unknown>): Promise<boolean> {
  return (await submitRelayOutcome(report)) !== null;
}

async function persistPreparedJournal(item: QueuedRelay): Promise<RelayJournalEntry | null> {
  return serializeQueueMutation(async () => {
    const state = await readRelayQueueState();
    const currentItem = state.pending.find((candidate) => candidate.id === item.id);
    if (!currentItem) return null;
    const existing = state.journal.find((entry) => entry.queueItemId === item.id);
    if (existing?.state === "delivered" || existing?.state === "committed") return null;
    const prepared = existing ?? prepareJournalEntry(currentItem, state.revision);
    const storage = await writeRelayQueueState({
      pending: state.pending.map((candidate) => candidate.id === currentItem.id ? currentItem : candidate),
      deadLetters: state.deadLetters,
      journal: upsertJournalEntry(state.journal, prepared),
    });
    return storage === "persistent" ? prepared : null;
  });
}

async function persistDeliveredJournal(item: QueuedRelay, disposition: RelayDeliveryDisposition): Promise<boolean> {
  return serializeQueueMutation(async () => {
    const state = await readRelayQueueState();
    const journal = markJournalDelivered(state.journal, item, disposition);
    if (journal === state.journal) return false;
    return (await writeRelayQueueState({ pending: state.pending, deadLetters: state.deadLetters, journal })) === "persistent";
  });
}

async function recoverDeliveredJournal(): Promise<void> {
  await serializeQueueMutation(async () => {
    const state = await readRelayQueueState();
    const journal = commitDeliveredJournal(state.journal, state.pending);
    if (journal.every((entry, index) => entry === state.journal[index])) return;
    await writeRelayQueueState({ pending: state.pending, deadLetters: state.deadLetters, journal });
  });
}

async function handleRelayMessage(raw: string): Promise<void> {
  let envelope: MeshEnvelope;
  try { envelope = JSON.parse(raw); } catch { return; }
  if (envelope.type !== "report") return;
  const powPrefix = typeof envelope.powPrefix === "string" ? envelope.powPrefix : "";
  const powNonce = typeof envelope.powNonce === "number" ? envelope.powNonce : -1;
  const powDifficulty = typeof envelope.powDifficulty === "number" ? envelope.powDifficulty : 0;
  if (!isRelayEnvelopeAdmissible(envelope)) return;
  const powOk = await verifyPoW(powPrefix, powNonce, powDifficulty).catch(() => false);
  if (!powOk) return;
  const report = buildRelayedPayload(envelope);
  if (!report) return;
  const replayReservation = reserveRelayHash(raw);
  if (!replayReservation) return;
  const enqueued = await enqueueRelay(report);
  if (!enqueued.accepted) {
    releaseRelayHash(replayReservation);
    return;
  }
  await flushQueue();
}

export function enqueueRelay(report: Record<string, unknown>): Promise<RelayEnqueueResult> {
  if (!isValidClientGeneratedId(report.clientGeneratedId)) {
    console.error("[MeshRelay] Rejecting relay enqueue: missing origin clientGeneratedId");
    return Promise.resolve({ accepted: false, reason: "missing_origin_client_generated_id" });
  }
  const now = Date.now();
  const item = { id: queueItemId(), report, ts: now, attempts: 0, nextAttemptAt: now } satisfies QueuedRelay;
  return serializeQueueMutation(async () => {
    const state = await readRelayQueueState();
    const transition = makeCapacityTransition(state, item, now);
    if (transition.capacityProtected) {
      console.error("[MeshRelay] Rejecting relay enqueue: all pending items are journal-protected");
      return { accepted: false, reason: "queue_capacity_protected" };
    }
    const storage = await writeRelayQueueState(transition);
    if (storage === "persistent") return { accepted: true, storage };
    if (transition.requiresDlq) {
      console.error("[MeshRelay] Rejecting relay enqueue: dead-letter persistence unavailable");
      return { accepted: false, reason: "dead_letter_unavailable" };
    }
    volatilePending = [...state.pending, item];
    console.error("[MeshRelay] Queue persistence unavailable; retaining pending item in memory only");
    return { accepted: true, storage: "volatile" };
  });
}

async function flushQueueInternal(): Promise<void> {
  await recoverDeliveredJournal();
  const now = Date.now();
  const state = await readRelayQueueState();
  if (state.pending.length === 0) return;
  const processedIds = new Set<string>();
  const updatedItems = new Map<string, QueuedRelay>();
  let changed = false;
  for (const item of state.pending) {
    if (now - item.ts >= RELAY_MAX_QUEUE_AGE_MS) {
      updatedItems.set(item.id, { ...item, deadLetter: true, deadLetteredAt: now, lastError: "expired" });
      changed = true;
      continue;
    }
    if (item.nextAttemptAt > now) continue;
    if (!isValidClientGeneratedId(item.report.clientGeneratedId)) {
      updatedItems.set(item.id, { ...item, deadLetter: true, deadLetteredAt: now, lastError: "missing_origin_client_generated_id" });
      console.error("[MeshRelay] Quarantining legacy pending item without origin clientGeneratedId");
      changed = true;
      continue;
    }
    if (!(await persistPreparedJournal(item))) continue;
    const disposition = await submitRelayOutcome(item.report);
    if (disposition && await persistDeliveredJournal(item, disposition)) {
      processedIds.add(item.id);
      changed = true;
      continue;
    }
    if (disposition) continue;
    const attempts = item.attempts + 1;
    const deadLetter = attempts >= RELAY_MAX_QUEUE_ATTEMPTS;
    const backoff = Math.min(RELAY_BASE_RETRY_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), RELAY_MAX_RETRY_BACKOFF_MS);
    updatedItems.set(item.id, { ...item, attempts, nextAttemptAt: now + backoff, deadLetter, deadLetteredAt: deadLetter ? now : undefined, lastError: "submission failed" });
    changed = true;
  }
  if (!changed) return;
  let queueCommitted = false;
  await serializeQueueMutation(async () => {
    const latestState = await readRelayQueueState();
    const deadLetterMoves: QueuedRelay[] = [];
    const nextPending = latestState.pending
      .filter((item) => !processedIds.has(item.id))
      .flatMap((item) => {
        const updated = updatedItems.get(item.id) ?? item;
        if (updated.deadLetter) {
          deadLetterMoves.push(updated);
          return [];
        }
        return [updated];
      });
    const storage = await writeRelayQueueState({
      pending: nextPending,
      deadLetters: [...latestState.deadLetters, ...deadLetterMoves],
      journal: latestState.journal,
    });
    if (storage === "persistent") {
      queueCommitted = true;
      return;
    }
    if (storage === "failed") {
      const deadLetterMoveIds = new Set(deadLetterMoves.map((item) => item.id));
      volatilePending = latestState.pending
        .filter((item) => !processedIds.has(item.id))
        .map((item) => deadLetterMoveIds.has(item.id) ? item : (updatedItems.get(item.id) ?? item));
      volatilePendingIsAuthoritative = true;
      console.error("[MeshRelay] Queue reconciliation persistence unavailable; preserving pending source items");
    }
  });
  if (queueCommitted) await recoverDeliveredJournal();
}

export function flushQueue(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = flushQueueInternal().finally(() => { flushInFlight = null; });
  return flushInFlight;
}

let started = false;
export function initMeshRelay(): void {
  if (started) return;
  started = true;
  onMeshMessage((message) => { void handleRelayMessage(message); });
  const flush = () => { void flushQueue(); };
  window.addEventListener("online", flush);
  window.setInterval(flush, 60_000);
}
