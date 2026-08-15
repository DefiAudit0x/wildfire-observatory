import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

type Snapshot = {
  revision: number;
  pending: Array<{ report: { clientGeneratedId: string } }>;
  deadLetters: Array<{ report: { clientGeneratedId: string } }>;
};

function storedSnapshot(): Snapshot {
  return JSON.parse(storage.get("mesh_relay_queue") || '{"revision":0,"pending":[],"deadLetters":[]}') as Snapshot;
}

function createDelayedIndexedDb(writeDelayMs: number, initialSnapshot?: Snapshot) {
  let stored: unknown = initialSnapshot;
  let writeCount = 0;
  let abortCount = 0;
  const objectStoreNames = { contains: () => true };
  const db = {
    objectStoreNames,
    createObjectStore: () => ({}),
    transaction: () => {
      let aborted = false;
      const objectStore = {
        get: () => {
          const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
          queueMicrotask(() => {
            request.result = stored;
            request.onsuccess?.();
          });
          return request;
        },
        put: (value: unknown) => {
          const request: { onsuccess?: () => void; onerror?: () => void } = {};
          writeCount += 1;
          globalThis.setTimeout(() => {
            if (aborted) return;
            stored = value;
            request.onsuccess?.();
          }, writeDelayMs);
          return request;
        },
      };
      return {
        objectStore: () => objectStore,
        abort: () => {
          aborted = true;
          abortCount += 1;
        },
      };
    },
  };
  return {
    factory: {
      open: () => {
        const request: {
          result: typeof db;
          onupgradeneeded?: () => void;
          onsuccess?: () => void;
          onerror?: () => void;
          onblocked?: () => void;
        } = { result: db };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    } as unknown as IDBFactory,
    getStored: () => stored as Snapshot | undefined,
    getWriteCount: () => writeCount,
    getAbortCount: () => abortCount,
  };
}

describe("mesh relay IndexedDB timeout recovery", () => {
  beforeEach(() => {
    storage.clear();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps the newest fallback snapshot authoritative after a late IndexedDB write", async () => {
    const indexed = createDelayedIndexedDb(200);
    vi.stubGlobal("indexedDB", indexed.factory);
    const relay = await import("../src/lib/meshRelay.js");

    const first = relay.enqueueRelay({ clientGeneratedId: "late-a" });
    await vi.advanceTimersByTimeAsync(101);
    await first;

    await relay.enqueueRelay({ clientGeneratedId: "late-b" });
    expect(indexed.getWriteCount()).toBe(1);
    expect(storedSnapshot().revision).toBe(2);
    expect(storedSnapshot().pending.map((item) => item.report.clientGeneratedId)).toEqual(["late-a", "late-b"]);

    await vi.advanceTimersByTimeAsync(100);
    expect(indexed.getStored()).toBeUndefined();
    expect(indexed.getAbortCount()).toBe(1);

    vi.resetModules();
    const afterReload = await import("../src/lib/meshRelay.js");
    const third = afterReload.enqueueRelay({ clientGeneratedId: "late-c" });
    await vi.advanceTimersByTimeAsync(101);
    await third;

    expect(storedSnapshot().revision).toBe(3);
    expect(storedSnapshot().pending.map((item) => item.report.clientGeneratedId))
      .toEqual(["late-a", "late-b", "late-c"]);
  });

  it("selects a higher IndexedDB revision than localStorage after reload", async () => {
    const indexed = createDelayedIndexedDb(0, {
      revision: 12,
      pending: [{ report: { clientGeneratedId: "indexed-revision-12" } }],
      deadLetters: [],
    });
    storage.set("mesh_relay_queue", JSON.stringify({
      revision: 11,
      pending: [{ report: { clientGeneratedId: "local-revision-11" } }],
      deadLetters: [],
    }));
    vi.stubGlobal("indexedDB", indexed.factory);

    const relay = await import("../src/lib/meshRelay.js");
    const enqueue = relay.enqueueRelay({ clientGeneratedId: "after-reload" });
    await vi.advanceTimersByTimeAsync(1);
    await enqueue;

    expect(indexed.getStored()?.revision).toBe(13);
    expect(indexed.getStored()?.pending.map((item) => item.report.clientGeneratedId))
      .toEqual(["indexed-revision-12", "after-reload"]);
    expect(storedSnapshot().revision).toBe(13);
  });

  it("aborts a timed-out DLQ transition before returning dead_letter_unavailable", async () => {
    const pending = Array.from({ length: 50 }, (_, index) => ({
      report: { clientGeneratedId: `source-${index}` },
      id: `source-${index}`,
      ts: index,
      attempts: 0,
      nextAttemptAt: 0,
    }));
    const indexed = createDelayedIndexedDb(200, { revision: 10, pending, deadLetters: [] });
    vi.stubGlobal("indexedDB", indexed.factory);
    vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const relay = await import("../src/lib/meshRelay.js");

    const enqueue = relay.enqueueRelay({ clientGeneratedId: "rejected-after-timeout" });
    await vi.advanceTimersByTimeAsync(101);
    await expect(enqueue).resolves.toEqual({ accepted: false, reason: "dead_letter_unavailable" });

    await vi.advanceTimersByTimeAsync(100);
    expect(indexed.getAbortCount()).toBe(1);
    expect(indexed.getStored()?.pending.map((item) => item.report.clientGeneratedId))
      .toEqual(Array.from({ length: 50 }, (_, index) => `source-${index}`));
    expect(indexed.getStored()?.deadLetters).toEqual([]);
  });
});
