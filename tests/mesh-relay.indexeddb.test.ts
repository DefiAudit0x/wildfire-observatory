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

function createDelayedIndexedDb(
  writeDelayMs: number,
  initialSnapshot?: Snapshot,
  writeOutcome: "complete" | "abort" = "complete",
  transactionDelayMs = 0
) {
  let stored: unknown = initialSnapshot;
  let writeCount = 0;
  let abortCount = 0;
  const objectStoreNames = { contains: () => true };
  const db = {
    objectStoreNames,
    createObjectStore: () => ({}),
    transaction: () => {
      let aborted = false;
      const transaction: {
        objectStore: () => typeof objectStore;
        abort: () => void;
        onabort?: () => void;
        oncomplete?: () => void;
        onerror?: () => void;
      } = {
        objectStore: () => objectStore,
        abort: () => {
          if (aborted) return;
          aborted = true;
          abortCount += 1;
          queueMicrotask(() => transaction.onabort?.());
        },
      };
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
            request.onsuccess?.();
            globalThis.setTimeout(() => {
              if (aborted) return;
              if (writeOutcome === "abort") {
                transaction.onabort?.();
                return;
              }
              stored = value;
              transaction.oncomplete?.();
            }, transactionDelayMs);
          }, writeDelayMs);
          return request;
        },
      };
      return transaction;
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

    const first = relay.enqueueRelay({ clientGeneratedId: "late-a-01" });
    await vi.advanceTimersByTimeAsync(101);
    await first;

    await relay.enqueueRelay({ clientGeneratedId: "late-b-01" });
    expect(indexed.getWriteCount()).toBe(1);
    expect(storedSnapshot().revision).toBe(2);
    expect(storedSnapshot().pending.map((item) => item.report.clientGeneratedId)).toEqual(["late-a-01", "late-b-01"]);

    await vi.advanceTimersByTimeAsync(100);
    expect(indexed.getStored()).toBeUndefined();
    expect(indexed.getAbortCount()).toBe(1);

    vi.resetModules();
    const afterReload = await import("../src/lib/meshRelay.js");
    const third = afterReload.enqueueRelay({ clientGeneratedId: "late-c-01" });
    await vi.advanceTimersByTimeAsync(101);
    await third;

    expect(storedSnapshot().revision).toBe(3);
    expect(storedSnapshot().pending.map((item) => item.report.clientGeneratedId))
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
    expect(indexed.getStored()?.pending.map((item) => item.report.clientGeneratedId))
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
    await vi.advanceTimersByTimeAsync(101);
    await expect(enqueue).resolves.toEqual({ accepted: false, reason: "dead_letter_unavailable" });

    await vi.advanceTimersByTimeAsync(100);
    expect(indexed.getAbortCount()).toBe(1);
    expect(indexed.getStored()?.pending.map((item) => item.report.clientGeneratedId))
      .toEqual(Array.from({ length: 50 }, (_, index) => `source-${index}`));
    expect(indexed.getStored()?.deadLetters).toEqual([]);
  });

  it("waits for transaction complete before confirming a persistent write", async () => {
    const indexed = createDelayedIndexedDb(0, undefined, "complete", 25);
    vi.stubGlobal("indexedDB", indexed.factory);
    const relay = await import("../src/lib/meshRelay.js");

    let result: unknown;
    const enqueue = relay.enqueueRelay({ clientGeneratedId: "complete-after-request-success" })
      .then((value) => {
        result = value;
        return value;
      });

    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeUndefined();
    expect(indexed.getStored()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(25);
    await expect(enqueue).resolves.toEqual({ accepted: true, storage: "persistent" });
    expect(indexed.getStored()?.pending.map((item) => item.report.clientGeneratedId))
      .toEqual(["complete-after-request-success"]);
  });

  it("keeps volatile state when request success is followed by transaction abort", async () => {
    const pending = Array.from({ length: 49 }, (_, index) => ({
      report: { clientGeneratedId: `source-${index}` },
      id: `source-${index}`,
      ts: index,
      attempts: 0,
      nextAttemptAt: 0,
    }));
    const indexed = createDelayedIndexedDb(
      0,
      { revision: 10, pending, deadLetters: [] },
      "abort",
      25
    );
    vi.stubGlobal("indexedDB", indexed.factory);
    vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const relay = await import("../src/lib/meshRelay.js");

    const volatileEnqueue = relay.enqueueRelay({ clientGeneratedId: "volatile-after-abort" });
    await vi.advanceTimersByTimeAsync(26);
    await expect(volatileEnqueue).resolves.toEqual({ accepted: true, storage: "volatile" });

    const rejectedEnqueue = relay.enqueueRelay({ clientGeneratedId: "rejected-after-abort" });
    await vi.advanceTimersByTimeAsync(26);
    await expect(rejectedEnqueue).resolves.toEqual({ accepted: false, reason: "dead_letter_unavailable" });

    expect(indexed.getStored()?.pending.map((item) => item.report.clientGeneratedId))
      .toEqual(Array.from({ length: 49 }, (_, index) => `source-${index}`));
    expect(indexed.getStored()?.deadLetters).toEqual([]);
  });
});
