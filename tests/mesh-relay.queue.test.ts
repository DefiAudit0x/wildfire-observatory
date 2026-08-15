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
  lastError?: string;
}> {
  const value = JSON.parse(storage.get("mesh_relay_queue") || "[]") as unknown;
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const state = value as {
    items?: Array<{ report: { clientGeneratedId?: string }; attempts?: number; nextAttemptAt?: number; deadLetter?: boolean; lastError?: string }>;
    pending?: Array<{ report: { clientGeneratedId?: string }; attempts?: number; nextAttemptAt?: number; deadLetter?: boolean; lastError?: string }>;
    deadLetters?: Array<{ report: { clientGeneratedId?: string }; attempts?: number; nextAttemptAt?: number; deadLetter?: boolean; lastError?: string }>;
  };
  if (Array.isArray(state.pending) || Array.isArray(state.deadLetters)) {
    return [...(state.deadLetters ?? []), ...(state.pending ?? [])];
  }
  return Array.isArray(state.items) ? state.items : [];
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

  it("moves the oldest pending item to capacity dead-letter instead of silently dropping item 51", async () => {
    for (let i = 0; i < 51; i++) {
      await enqueueRelay({ clientGeneratedId: `capacity-${i}` });
    }

    const saved = storedQueue();
    const pending = saved.filter((item) => !item.deadLetter);
    const deadLetters = saved.filter((item) => item.deadLetter);
    expect(pending).toHaveLength(50);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].report.clientGeneratedId).toBe("capacity-0");
    expect(deadLetters[0].lastError).toBe("capacity_exceeded");
    expect(pending.some((item) => item.report.clientGeneratedId === "capacity-50")).toBe(true);
  });

  it("keeps DLQ separate from pending without silently truncating dead-letter history", async () => {
    for (let i = 0; i < 101; i++) {
      await enqueueRelay({ clientGeneratedId: `durable-dlq-${i}` });
    }

    const saved = storedQueue();
    expect(saved).toHaveLength(101);
    expect(saved.filter((item) => !item.deadLetter)).toHaveLength(50);
    expect(saved.filter((item) => item.deadLetter && item.lastError === "capacity_exceeded")).toHaveLength(51);
    expect(saved.map((item) => item.report.clientGeneratedId).sort())
      .toEqual(Array.from({ length: 101 }, (_, index) => `durable-dlq-${index}`).sort());
  });

  it("rejects a capacity overflow when DLQ persistence fails and preserves the pending source", async () => {
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    for (let i = 0; i < 50; i++) {
      await expect(enqueueRelay({ clientGeneratedId: `volatile-capacity-${i}` })).resolves.toMatchObject({
        accepted: true,
        storage: "volatile",
      });
    }
    await expect(enqueueRelay({ clientGeneratedId: "rejected-capacity" })).resolves.toEqual({
      accepted: false,
      reason: "dead_letter_unavailable",
    });

    setItem.mockRestore();
    await expect(enqueueRelay({ clientGeneratedId: "recovered-capacity" })).resolves.toMatchObject({ accepted: true });
    const saved = storedQueue();
    expect(saved).toHaveLength(51);
    expect(saved.filter((item) => !item.deadLetter)).toHaveLength(50);
    expect(saved.filter((item) => item.deadLetter && item.lastError === "capacity_exceeded")).toHaveLength(1);
    expect(saved.some((item) => item.report.clientGeneratedId === "rejected-capacity")).toBe(false);
    expect(saved.some((item) => item.report.clientGeneratedId === "volatile-capacity-0" && item.deadLetter)).toBe(true);
    expect(saved.some((item) => item.report.clientGeneratedId === "recovered-capacity" && !item.deadLetter)).toBe(true);
  });

  it("preserves a pending source when flush cannot persist its DLQ transition", async () => {
    await enqueueRelay({ clientGeneratedId: "expired-dlq-source" });
    const persisted = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    persisted.pending[0].ts = Date.now() - RELAY_MAX_QUEUE_AGE_MS - 1;
    storage.set("mesh_relay_queue", JSON.stringify(persisted));

    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();
    setItem.mockRestore();

    await enqueueRelay({ clientGeneratedId: "after-dlq-failure" });
    const saved = storedQueue();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved.filter((item) => item.deadLetter)).toHaveLength(0);
    expect(saved.some((item) => item.report.clientGeneratedId === "expired-dlq-source" && !item.deadLetter)).toBe(true);
    expect(saved.some((item) => item.report.clientGeneratedId === "after-dlq-failure" && !item.deadLetter)).toBe(true);
  });

  it("does not replay a delivered report when a mixed flush cannot persist its DLQ transition", async () => {
    await enqueueRelay({ clientGeneratedId: "delivered-before-dlq-failure" });
    await enqueueRelay({ clientGeneratedId: "dlq-source-after-persistence-failure" });
    const persisted = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    const source = persisted.pending.find((item: { report: { clientGeneratedId: string } }) =>
      item.report.clientGeneratedId === "dlq-source-after-persistence-failure"
    );
    source.attempts = 7;
    storage.set("mesh_relay_queue", JSON.stringify(persisted));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    let writes = 0;
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes === 4) throw new Error("quota");
      storage.set(key, value);
    });
    await flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    setItem.mockRestore();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await flushQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).clientGeneratedId)
      .toBe("dlq-source-after-persistence-failure");
    const saved = storedQueue();
    expect(saved).toHaveLength(1);
    expect(saved[0].report.clientGeneratedId).toBe("dlq-source-after-persistence-failure");
    expect(saved[0].deadLetter).toBe(true);
  });

  it("does not replay delivered reports when all-success flush persistence fails", async () => {
    await enqueueRelay({ clientGeneratedId: "delivered-a-after-persistence-failure" });
    await enqueueRelay({ clientGeneratedId: "delivered-b-after-persistence-failure" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let writes = 0;
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes === 5) throw new Error("quota");
      storage.set(key, value);
    });
    await flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    setItem.mockRestore();
    fetchMock.mockClear();
    await flushQueue();
    expect(fetchMock).not.toHaveBeenCalled();

    await enqueueRelay({ clientGeneratedId: "post-recovery" });
    const saved = storedQueue();
    expect(saved).toHaveLength(1);
    expect(saved[0].report.clientGeneratedId).toBe("post-recovery");
  });

  it("preserves every report as pending or capacity dead-letter during concurrent overflow", async () => {
    const ids = Array.from({ length: 52 }, (_, index) => `overflow-concurrent-${index}`);
    for (const id of ids.slice(0, 49)) {
      await enqueueRelay({ clientGeneratedId: id });
    }
    await Promise.all(ids.slice(49).map((clientGeneratedId) => enqueueRelay({ clientGeneratedId })));

    const saved = storedQueue();
    expect(saved.filter((item) => !item.deadLetter)).toHaveLength(50);
    expect(saved.filter((item) => item.deadLetter && item.lastError === "capacity_exceeded")).toHaveLength(2);
    expect(saved.map((item) => item.report.clientGeneratedId).sort()).toEqual(ids.sort());
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

  it("preserves volatile items when a failed flush overlaps with enqueue", async () => {
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await enqueueRelay({ clientGeneratedId: "volatile-a" });
    setItem.mockRestore();

    let writes = 0;
    const failQueueTransition = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes === 3) throw new Error("quota");
      storage.set(key, value);
    });

    let resolveFirst: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn().mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFirst = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const flush = flushQueue();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await enqueueRelay({ clientGeneratedId: "volatile-b" });
    resolveFirst!(new Response(null, { status: 503 }));
    await flush;
    failQueueTransition.mockRestore();

    await enqueueRelay({ clientGeneratedId: "volatile-c" });
    const saved = storedQueue();
    expect(saved.map((item) => item.report.clientGeneratedId).sort())
      .toEqual(["volatile-a", "volatile-b", "volatile-c"]);
    expect(saved.find((item) => item.report.clientGeneratedId === "volatile-a")?.attempts).toBe(1);
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
