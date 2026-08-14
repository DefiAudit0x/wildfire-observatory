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

type Snapshot = { revision: number; items: Array<{ report: { clientGeneratedId: string } }> };

function storedSnapshot(): Snapshot {
  return JSON.parse(storage.get("mesh_relay_queue") || '{"revision":0,"items":[]}') as Snapshot;
}

function createDelayedIndexedDb(writeDelayMs: number) {
  let stored: unknown = undefined;
  let writeCount = 0;
  const objectStoreNames = { contains: () => true };
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
        stored = value;
        request.onsuccess?.();
      }, writeDelayMs);
      return request;
    },
  };
  const db = {
    objectStoreNames,
    createObjectStore: () => objectStore,
    transaction: () => ({ objectStore: () => objectStore }),
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
    expect(storedSnapshot().items.map((item) => item.report.clientGeneratedId)).toEqual(["late-a", "late-b"]);

    await vi.advanceTimersByTimeAsync(100);
    expect(indexed.getStored()?.revision).toBe(1);

    vi.resetModules();
    const afterReload = await import("../src/lib/meshRelay.js");
    const third = afterReload.enqueueRelay({ clientGeneratedId: "late-c" });
    await vi.advanceTimersByTimeAsync(101);
    await third;

    expect(storedSnapshot().revision).toBe(3);
    expect(storedSnapshot().items.map((item) => item.report.clientGeneratedId))
      .toEqual(["late-a", "late-b", "late-c"]);
  });
});
