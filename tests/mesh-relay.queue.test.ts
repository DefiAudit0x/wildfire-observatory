import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
vi.stubGlobal("indexedDB", undefined);

const {
  checkAndRecordRelayHash,
  enqueueRelay,
  flushQueue,
  RELAY_MAX_QUEUE_AGE_MS,
  submitRelay,
} = await import("../src/lib/meshRelay.js");

function storedQueue(): Array<{
  report: { clientGeneratedId?: string };
  attempts?: number;
  nextAttemptAt?: number;
  deadLetter?: boolean;
}> {
  const value = JSON.parse(storage.get("mesh_relay_queue") || "[]") as unknown;
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
    ? (value as { items: Array<{ report: { clientGeneratedId?: string }; attempts?: number; nextAttemptAt?: number; deadLetter?: boolean }> }).items
    : [];
}

describe("mesh relay queue concurrency", () => {
  beforeEach(() => {
    storage.clear();
    vi.restoreAllMocks();
  });

  it("does not overwrite an item enqueued while a flush awaits the network", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(firstResponse);
    vi.stubGlobal("fetch", fetchMock);

    await enqueueRelay({ clientGeneratedId: "queued-a" });
    const firstFlush = flushQueue();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await enqueueRelay({ clientGeneratedId: "queued-b" });
    resolveFirst!(new Response(null, { status: 200 }));
    await firstFlush;

    const saved = storedQueue();
    expect(saved).toHaveLength(1);
    expect(saved[0].report.clientGeneratedId).toBe("queued-b");
  });

  it("shares one in-flight flush when online and interval triggers overlap", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(firstResponse);
    vi.stubGlobal("fetch", fetchMock);

    await enqueueRelay({ clientGeneratedId: "queued-overlap" });
    const firstFlush = flushQueue();
    const overlappingFlush = flushQueue();
    expect(overlappingFlush).toBe(firstFlush);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    resolveFirst!(new Response(null, { status: 200 }));
    await firstFlush;
    expect(storedQueue()).toEqual([]);
  });

  it("serializes concurrent enqueues so neither queued report is lost", async () => {
    await Promise.all([
      enqueueRelay({ clientGeneratedId: "concurrent-a" }),
      enqueueRelay({ clientGeneratedId: "concurrent-b" }),
    ]);

    const saved = storedQueue();
    expect(saved).toHaveLength(2);
    expect(saved.map((item) => item.report.clientGeneratedId).sort())
      .toEqual(["concurrent-a", "concurrent-b"]);
  });

  it("does not treat an unclassified 409 as a successful relay submission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "conflict" }), { status: 409 })));
    await expect(submitRelay({ clientGeneratedId: "conflict-unknown" })).resolves.toBe(false);
  });

  it("accepts only an explicitly classified duplicate 409", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "DUPLICATE_CLIENT_GENERATED_ID" }), { status: 409 })));
    await expect(submitRelay({ clientGeneratedId: "duplicate-known" })).resolves.toBe(true);
  });

  it("keeps an item in memory when storage is unavailable and flushes it after storage recovers", async () => {
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await enqueueRelay({ clientGeneratedId: "volatile-item" });
    setItem.mockRestore();

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off failed items and dead-letters items after the attempt cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await enqueueRelay({ clientGeneratedId: "retry-item" });
    await flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const afterFirstFailure = storedQueue();
    expect(afterFirstFailure[0].attempts).toBe(1);
    expect(afterFirstFailure[0].nextAttemptAt).toBeGreaterThan(Date.now());

    await flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    afterFirstFailure[0].nextAttemptAt = Date.now() - 1;
    afterFirstFailure[0].attempts = 7;
    storage.set("mesh_relay_queue", JSON.stringify(afterFirstFailure));
    await flushQueue();
    const deadLetter = storedQueue();
    expect(deadLetter[0].deadLetter).toBe(true);
    expect(deadLetter[0].attempts).toBe(8);
  });

  it("expires stale queue items without submitting them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    storage.set("mesh_relay_queue", JSON.stringify([{
      id: "expired-item",
      report: { clientGeneratedId: "expired-item" },
      ts: Date.now() - RELAY_MAX_QUEUE_AGE_MS - 1,
      attempts: 0,
      nextAttemptAt: Date.now(),
    }]));

    await flushQueue();
    expect(fetchMock).not.toHaveBeenCalled();
    const expired = storedQueue();
    expect(expired[0].deadLetter).toBe(true);
  });

  it("fails closed when relay replay capacity is full before retention expires", () => {
    const now = Date.now();
    expect(checkAndRecordRelayHash(`relay-capacity-first-${now}`, now)).toBe(true);
    for (let i = 0; i < 1999; i++) {
      expect(checkAndRecordRelayHash(`relay-capacity-${now}-${i}`, now)).toBe(true);
    }
    expect(checkAndRecordRelayHash(`relay-capacity-overflow-${now}`, now)).toBe(false);
    expect(checkAndRecordRelayHash(`relay-capacity-first-${now}`, now)).toBe(false);
  });
});
