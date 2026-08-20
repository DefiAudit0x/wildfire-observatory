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

function storedSnapshot(): any {
  return JSON.parse(storage.get("mesh_relay_queue") || "{}");
}

function createDelayedIndexedDb(delayMs: number, initialState?: unknown) {
  let stored = initialState;
  let writeCount = 0;
  let abortCount = 0;
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction: () => {
      const transaction: any = {
        objectStore: () => objectStore,
        abort: () => {
          abortCount += 1;
          queueMicrotask(() => transaction.onabort?.());
        },
      };
      const objectStore = {
        get: (key: string) => {
          const request: any = {};
          queueMicrotask(() => {
            request.result = key === "state" ? stored : undefined;
            request.onsuccess?.();
          });
          return request;
        },
        put: (value: unknown) => {
          writeCount += 1;
          const request: any = {};
          setTimeout(() => {
            stored = value;
            request.onsuccess?.();
            transaction.oncomplete?.();
          }, delayMs);
          return request;
        },
      };
      return transaction;
    },
  };
  return {
    factory: {
      open: () => {
        const request: any = { result: db };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    } as IDBFactory,
    getStored: () => stored as any,
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

    const first = relay.enqueueRelay({ clientGeneratedId: "late-a-01" });
    await vi.advanceTimersByTimeAsync(101);
    await first;

    await relay.enqueueRelay({ clientGeneratedId: "late-b-01" });
    expect(indexed.getWriteCount()).toBe(1);
    expect(storedSnapshot().revision).toBe(2);
    expect(storedSnapshot().pending.map((item: any) => item.report.clientGeneratedId)).toEqual(["late-a-01", "late-b-01"]);

    await vi.advanceTimersByTimeAsync(100);
    expect(indexed.getStored()).toBeUndefined();
    expect(indexed.getAbortCount()).toBe(1);

    vi.resetModules();
    const afterReload = await import("../src/lib/meshRelay.js");
    const third = afterReload.enqueueRelay({ clientGeneratedId: "late-c-01" });
    await vi.advanceTimersByTimeAsync(101);
    await third;

    expect(storedSnapshot().revision).toBe(3);
    expect(storedSnapshot().pending.map((item: any) => item.report.clientGeneratedId))
      .toEqual(["late-a-01", "late-b-01", "late-c-01"]);
  });

  it("merges a higher IndexedDB revision with localStorage after reload instead of discarding the other replica", async () => {
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
    expect(indexed.getStored()?.pending.map((item: any) => item.report.clientGeneratedId))
      .toEqual(["local-revision-11", "indexed-revision-12", "after-reload"]);
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