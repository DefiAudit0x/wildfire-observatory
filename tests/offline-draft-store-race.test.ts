// Fix 28 (DRAFT-2) — the offline draft store's merge must be one readwrite
// transaction, and a stale write must not overwrite a newer stored edit.
// jsdom has no IndexedDB, so the spec hand-rolls a fake following the
// createDelayedIndexedDb precedent (tests/mesh-relay.indexeddb.test.ts):
// a shared in-memory store, request objects delivered on a microtask, and
// readwrite-transaction serialization — a second readwrite transaction
// created while one is active queues until the active one completes. That
// serialization is what the single-transaction fix relies on, and it is what
// makes the old two-transaction shape fail: the other tab's tombstone
// commits between the old code's read and its write.
//
// The cross-tab hook (state.afterRead, one-shot, same shape as the
// report-migration-race afterSnapshot hook) fires when a getAll result is
// delivered, before the production code sees it — it writes the tombstone
// through the fake db directly, the way another tab would (it must NOT go
// through the store module's own enqueue mutex, which serializes same-tab
// callers and would make the interleaving impossible).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadOfflineDrafts,
  replaceOfflineDrafts,
  type OfflineDraftRecord,
} from "../src/utils/offlineDraftStore";

interface FakeRequest<T = unknown> {
  result?: T;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

const fakeState = {
  rows: new Map<string, OfflineDraftRecord>(),
  afterRead: () => {},
  activeWriteTx: null as FakeTransaction | null,
  writeQueue: [] as FakeTransaction[],
  storeCreated: false,
};

class FakeObjectStore {
  constructor(private tx: FakeTransaction) {}

  getAll(): FakeRequest<OfflineDraftRecord[]> {
    const request: FakeRequest<OfflineDraftRecord[]> = { onsuccess: null, onerror: null };
    this.tx.trackRequest();
    const snapshot = [...fakeState.rows.values()].map((r) => ({ ...r }));
    queueMicrotask(() => {
      // The cross-tab hook fires when the read is delivered — before the
      // production code sees the result.
      const hook = fakeState.afterRead;
      fakeState.afterRead = () => {};
      hook();
      request.result = snapshot;
      request.onsuccess?.();
      this.tx.settleRequest();
    });
    return request;
  }

  put(record: OfflineDraftRecord): FakeRequest {
    const request: FakeRequest = { onsuccess: null, onerror: null };
    this.tx.trackRequest();
    const apply = () => {
      fakeState.rows.set(record.id, { ...record });
      queueMicrotask(() => {
        request.onsuccess?.();
        this.tx.settleRequest();
      });
    };
    if (this.tx.isActive()) apply();
    else this.tx.queueOp(apply);
    return request;
  }

  delete(id: string): FakeRequest {
    const request: FakeRequest = { onsuccess: null, onerror: null };
    this.tx.trackRequest();
    const apply = () => {
      fakeState.rows.delete(id);
      queueMicrotask(() => {
        request.onsuccess?.();
        this.tx.settleRequest();
      });
    };
    if (this.tx.isActive()) apply();
    else this.tx.queueOp(apply);
    return request;
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private pending = 0;
  private completeScheduled = false;
  private queuedOps: Array<() => void> = [];
  private active: boolean;
  private aborted = false;
  // Fix 28b: a real IndexedDB abort rolls the transaction's writes back.
  // Snapshot the rows when the transaction becomes active so abort() can
  // restore them; without this the fake would commit puts that real IDB
  // discards, and the abort test would pass vacuously.
  private rowsSnapshot: Map<string, OfflineDraftRecord> | null = null;

  constructor(private mode: IDBTransactionMode) {
    if (mode === "readwrite") {
      if (fakeState.activeWriteTx) {
        fakeState.writeQueue.push(this);
        this.active = false;
      } else {
        fakeState.activeWriteTx = this;
        this.active = true;
        this.ensureSnapshot();
      }
    } else {
      this.active = true;
    }
    // A transaction with zero requests still completes in real IndexedDB —
    // without this, a replace that puts nothing (e.g. every incoming record
    // skipped by the tombstone branch) would hang forever. Requests are
    // always issued synchronously after creation in this codebase, so by
    // the time this microtask runs, pending is exact.
    queueMicrotask(() => this.maybeComplete());
  }

  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this);
  }

  isActive(): boolean {
    return this.active;
  }

  queueOp(op: () => void): void {
    this.queuedOps.push(op);
  }

  trackRequest(): void {
    this.pending++;
  }

  settleRequest(): void {
    this.pending--;
    this.maybeComplete();
  }

  private maybeComplete(): void {
    if (this.aborted || this.pending !== 0 || this.completeScheduled) return;
    this.completeScheduled = true;
    queueMicrotask(() => {
      this.completeScheduled = false;
      // A new request may have arrived meanwhile (e.g. puts issued inside a
      // getAll onsuccess) — wait for those instead of completing early.
      if (this.aborted || this.pending !== 0) return;
      this.oncomplete?.();
      if (this.mode === "readwrite") {
        fakeState.activeWriteTx = null;
        const next = fakeState.writeQueue.shift();
        if (next) next.activate();
      }
    });
  }

  private activate(): void {
    this.active = true;
    fakeState.activeWriteTx = this;
    this.ensureSnapshot();
    const ops = this.queuedOps.splice(0);
    for (const op of ops) op();
  }

  private ensureSnapshot(): void {
    if (this.rowsSnapshot) return;
    this.rowsSnapshot = new Map(fakeState.rows);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.active = false;
    if (this.rowsSnapshot) fakeState.rows = this.rowsSnapshot;
    if (this.mode === "readwrite" && fakeState.activeWriteTx === this) {
      fakeState.activeWriteTx = null;
      const next = fakeState.writeQueue.shift();
      if (next) next.activate();
    }
    queueMicrotask(() => {
      this.onabort?.();
    });
  }
}

const fakeDb = {
  objectStoreNames: {
    contains: (name: string) => name === "drafts" && fakeState.storeCreated,
  },
  createObjectStore: (_name: string, _options?: unknown) => {
    fakeState.storeCreated = true;
    return {};
  },
  transaction: (_name: string, mode: IDBTransactionMode) => new FakeTransaction(mode),
  close: () => {},
};

const fakeIndexedDB = {
  open: (_name: string, _version: number) => {
    const request: {
      result?: typeof fakeDb;
      onupgradeneeded: (() => void) | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (!fakeState.storeCreated) {
        request.result = fakeDb;
        request.onupgradeneeded?.();
      }
      request.result = fakeDb;
      request.onsuccess?.();
    });
    return request;
  },
};

function seed(record: OfflineDraftRecord): void {
  fakeState.rows.set(record.id, { ...record });
}

function writeTombstoneFromAnotherTab(id: string): void {
  // Another tab's deletion: a readwrite transaction on the same fake db.
  // It serializes behind an active write transaction (the fix) and runs
  // immediately otherwise (the old code's read is a readonly transaction).
  const tx = fakeDb.transaction("drafts", "readwrite");
  tx.objectStore().put({ id, deletedAt: Date.now() });
}

beforeEach(() => {
  fakeState.rows.clear();
  fakeState.afterRead = () => {};
  fakeState.activeWriteTx = null;
  fakeState.writeQueue.length = 0;
  fakeState.storeCreated = false;
  vi.stubGlobal("indexedDB", fakeIndexedDB as unknown as IDBFactory);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Fix 28 DRAFT-2 — draft store merge is one transaction, freshness wins", () => {
  it("a tombstone written between the read and the write survives the replace", async () => {
    // Tab A holds a stale snapshot: D at updatedAt 1000. Tab B deletes D
    // while A's replace is in flight; A's incoming edit is NEWER (2000),
    // so freshness alone cannot save it — only the single transaction can.
    seed({ id: "d1", content: "old", updatedAt: 1000 });
    fakeState.afterRead = () => writeTombstoneFromAnotherTab("d1");
    await replaceOfflineDrafts([{ id: "d1", content: "newer", updatedAt: 2000 }]);
    expect(await loadOfflineDrafts()).toEqual([]);
  });

  it("a tombstone visible in the read still wins (control)", async () => {
    seed({ id: "d1", deletedAt: Date.now() });
    await replaceOfflineDrafts([{ id: "d1", content: "stale", updatedAt: 1000 }]);
    expect(await loadOfflineDrafts()).toEqual([]);
  });

  it("a stale live write does not overwrite a newer stored edit", async () => {
    seed({ id: "d1", content: "newer", updatedAt: 2000 });
    await replaceOfflineDrafts([{ id: "d1", content: "older", updatedAt: 1000 }]);
    const loaded = await loadOfflineDrafts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe("newer");
    expect(loaded[0].updatedAt).toBe(2000);
  });

  it("a newer incoming write wins and is restamped", async () => {
    seed({ id: "d1", content: "older", updatedAt: 2000 });
    await replaceOfflineDrafts([{ id: "d1", content: "newer", updatedAt: 3000 }]);
    const loaded = await loadOfflineDrafts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe("newer");
    expect(loaded[0].updatedAt).toBeGreaterThan(2000);
  });

  it("an unchanged record keeps its stored stamp", async () => {
    seed({ id: "d1", content: "same", updatedAt: 2000 });
    await replaceOfflineDrafts([{ id: "d1", content: "same", updatedAt: 1000 }]);
    const loaded = await loadOfflineDrafts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].updatedAt).toBe(2000);
  });
});

describe("Fix 28b — replace returns the committed records, failures roll back", () => {
  it("returns the record with the store's stamp", async () => {
    const committed = await replaceOfflineDrafts([{ id: "d1", content: "draft" }]);
    expect(committed).toHaveLength(1);
    expect(typeof committed[0].updatedAt).toBe("number");
    const stored = await loadOfflineDrafts();
    expect(stored[0].updatedAt).toBe(committed[0].updatedAt);
  });

  it("a retry update built on the returned record persists; built on the stale snapshot it does not", async () => {
    const [committed] = await replaceOfflineDrafts([{ id: "d1", content: "draft" }]);
    // Stale snapshot: the pre-write input plus retry metadata, no stamp —
    // the freshness guard skips it, and the call hands the stored record
    // back so the caller holds the truth instead of phantom metadata.
    const staleRetry = await replaceOfflineDrafts([
      { id: "d1", content: "draft", retryCount: 1, lastError: "network down" },
    ]);
    expect(staleRetry).toHaveLength(1);
    expect(staleRetry[0].retryCount).toBeUndefined();
    expect(staleRetry[0].updatedAt).toBe(committed.updatedAt);
    expect((await loadOfflineDrafts())[0].retryCount).toBeUndefined();
    // Built on the RETURNED record, the same retry update persists (tie wins).
    const freshRetry = await replaceOfflineDrafts([
      { ...committed, retryCount: 1, lastError: "network down" },
    ]);
    expect(freshRetry[0].retryCount).toBe(1);
    expect((await loadOfflineDrafts())[0].retryCount).toBe(1);
  });

  it("a failure mid-merge rolls the whole batch back", async () => {
    // Seed directly (no restamp) so the d1 change is NEWER than the stored
    // stamp and its put really is queued before the failure.
    seed({ id: "d1", content: "original", updatedAt: 1000 });
    seed({ id: "d2", content: "original", updatedAt: 1000 });
    // stripStamp JSON-serialises every record it compares — a BigInt value
    // throws there, after the d1 put was already queued.
    const bad = { id: "d2", content: "bad", tag: 1n as unknown as string };
    await expect(
      replaceOfflineDrafts([
        { id: "d1", content: "changed", updatedAt: 2000 },
        bad,
      ]),
    ).rejects.toThrow();
    const stored = await loadOfflineDrafts();
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.id === "d1")?.content).toBe("original");
    expect(stored.find((r) => r.id === "d2")?.content).toBe("original");
  });
});
