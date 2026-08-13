export interface OfflineDraftRecord {
  id: string;
  [key: string]: unknown;
}

const DB_NAME = "wildfire-observatory-offline";
const STORE_NAME = "drafts";
const DB_VERSION = 1;
const LEGACY_KEY = "offline_drafts";

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
    return Array.isArray(parsed) ? parsed.filter((value): value is OfflineDraftRecord => Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string")) : [];
  } catch {
    return [];
  }
}

export async function loadOfflineDrafts(): Promise<OfflineDraftRecord[]> {
  if (!canUseIndexedDb()) return readLegacyDrafts();
  const db = await openDraftDb();
  try {
    const records = await new Promise<OfflineDraftRecord[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result as OfflineDraftRecord[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error("Unable to read offline drafts"));
    });
    if (records.length > 0) return records;
    const legacy = await readLegacyDrafts();
    if (legacy.length > 0) {
      await replaceOfflineDrafts(legacy);
      try { localStorage.removeItem(LEGACY_KEY); } catch { /* storage may be unavailable */ }
    }
    return legacy;
  } finally {
    db.close();
  }
}

export async function replaceOfflineDrafts(records: OfflineDraftRecord[]): Promise<void> {
  if (!canUseIndexedDb()) {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(records));
    return;
  }
  const db = await openDraftDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      store.clear();
      for (const record of records) store.put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to persist offline drafts"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline draft transaction aborted"));
    });
  } finally {
    db.close();
  }
}
