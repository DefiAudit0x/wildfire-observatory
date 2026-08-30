export interface OfflineDraftRecord {
  id: string;
  /** ARC-L15: per-record write stamp (ms epoch) maintained by this store. */
  updatedAt?: number;
  /** ARC-L15: deletion tombstone (ms epoch) — written by removeOfflineDrafts. */
  deletedAt?: number;
  [key: string]: unknown;
}

const DB_NAME = "wildfire-observatory-offline";
const STORE_NAME = "drafts";
const DB_VERSION = 1;
const LEGACY_KEY = "offline_drafts";
/** ARC-L15: tombstones older than this are pruned during writes. */
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// IndexedDB transactions are atomic individually, but read/replace calls from
// React effects and event handlers can still reorder at the application level.
// Serialize the public operations so an older initial read cannot overwrite a
// newer queue snapshot in component state.
let storageQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = storageQueue.then(operation, operation);
  storageQueue = run.then(() => undefined, () => undefined);
  return run;
}

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open offline draft storage"));
  });
}

async function readLegacyDrafts(): Promise<OfflineDraftRecord[]> {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is OfflineDraftRecord => Boolean(
        value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ))
      : [];
  } catch {
    return [];
  }
}

async function loadOfflineDraftsUnlocked(): Promise<OfflineDraftRecord[]> {
  if (!canUseIndexedDb()) return readLegacyDrafts();
  const db = await openDraftDb();
  try {
    // ARC-L15: tombstones are store bookkeeping, not drafts — never surface them.
    const records = (await readAllStore(db)).filter((r) => typeof r.deletedAt !== "number");
    if (records.length > 0) return records;
    const legacy = await readLegacyDrafts();
    if (legacy.length > 0) {
      await replaceOfflineDraftsUnlocked(legacy);
      try { localStorage.removeItem(LEGACY_KEY); } catch { /* storage may be unavailable */ }
    }
    return legacy;
  } finally {
    db.close();
  }
}

function readAllStore(db: IDBDatabase): Promise<OfflineDraftRecord[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as OfflineDraftRecord[]) ?? []);
    request.onerror = () => reject(request.error ?? new Error("Unable to read offline drafts"));
  });
}

function stripStamp(record: OfflineDraftRecord): string {
  return JSON.stringify({ ...record, updatedAt: undefined, deletedAt: undefined });
}

/**
 * ARC-L15: this is a MERGE, not a replacement. The old clear()+put-all made
 * every writer (including one holding the list as-read at mount) erase other
 * tabs' additions and resurrect their deletions. Now:
 *  - each incoming record is stamped and put only when it is new, changed, or
 *    newer than a tombstone;
 *  - records absent from the incoming list are deliberately LEFT UNTOUCHED —
 *    deletions are explicit via removeOfflineDrafts();
 *  - a tombstone newer than the incoming record wins (deletion guard).
 */
async function replaceOfflineDraftsUnlocked(records: OfflineDraftRecord[]): Promise<void> {
  if (!canUseIndexedDb()) {
    // Legacy single-store path (no IndexedDB): keep the historical full write;
    // this payload predates stamps and only serves migration.
    localStorage.setItem(LEGACY_KEY, JSON.stringify(records));
    return;
  }
  const db = await openDraftDb();
  try {
    const now = Date.now();
    const existing = await readAllStore(db);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const merged: OfflineDraftRecord[] = [];
    for (const record of records) {
      if (!record || typeof record.id !== "string" || typeof record.deletedAt === "number") continue;
      const prev = byId.get(record.id);
      if (prev && typeof prev.deletedAt === "number") {
        // Deleted in this or another tab: only a genuinely NEWER write of the
        // draft itself may resurrect it — a stale snapshot must not.
        if (typeof record.updatedAt === "number" && record.updatedAt > prev.deletedAt) {
          merged.push({ ...record, updatedAt: now });
        }
        continue;
      }
      if (prev && stripStamp(prev) === stripStamp(record)) {
        merged.push(prev); // unchanged elsewhere: keep the existing stamp
      } else {
        merged.push({ ...record, updatedAt: now });
      }
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      for (const record of merged) store.put(record);
      for (const r of existing) {
        if (typeof r.deletedAt === "number" && now - r.deletedAt > TOMBSTONE_RETENTION_MS) {
          store.delete(r.id);
        }
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to persist offline drafts"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline draft transaction aborted"));
    });
  } finally {
    db.close();
  }
}

/**
 * ARC-L15: explicit deletion. Writes a TOMBSTONE (not a bare delete) so a
 * concurrent tab holding a stale snapshot cannot resurrect the draft on its
 * next merge. Tombstones are pruned after TOMBSTONE_RETENTION_MS.
 */
async function removeOfflineDraftsUnlocked(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!canUseIndexedDb()) {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const rest = parsed.filter((v) => !(
        v && typeof v === "object" && ids.includes((v as { id?: unknown }).id as string)
      ));
      localStorage.setItem(LEGACY_KEY, JSON.stringify(rest));
    } catch { /* legacy cleanup is best effort */ }
    return;
  }
  const db = await openDraftDb();
  try {
    const now = Date.now();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      for (const id of ids) store.put({ id, deletedAt: now });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to remove offline drafts"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline draft removal aborted"));
    });
  } finally {
    db.close();
  }
}

export function loadOfflineDrafts(): Promise<OfflineDraftRecord[]> {
  return enqueue(loadOfflineDraftsUnlocked);
}

export function replaceOfflineDrafts(records: OfflineDraftRecord[]): Promise<void> {
  return enqueue(() => replaceOfflineDraftsUnlocked(records));
}

/** ARC-L15: explicit, tombstone-backed deletion (see removeOfflineDraftsUnlocked). */
export function removeOfflineDrafts(ids: string[]): Promise<void> {
  return enqueue(() => removeOfflineDraftsUnlocked(ids));
}
