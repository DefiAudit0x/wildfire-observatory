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

// ARC-M13: the relay confirms delivery only when the 200 response body
// satisfies the report contract (the server echoes the stored report), so
// these mocks model that body instead of a body-less 200.
let ok200Seq = 0;
function ok200(): Response {
  ok200Seq += 1;
  return new Response(JSON.stringify({
    id: `srv-relay-${ok200Seq}`,
    lat: 36.75,
    lng: 3.06,
    locationName: "Test location",
    wilaya: "Alger",
    description: "Relayed mesh report body",
    severity: "medium",
    status: "pending",
    timestamp: new Date().toISOString(),
    consensusCount: 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

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
    resolveFirst!(ok200());
    await firstFlush;

    const saved = storedQueue();
    expect(saved).toHaveLength(1);
    expect(saved[0].report.clientGeneratedId).toBe("queued-b");
  });

  it("does not submit an item moved to the DLQ while flush is awaiting an earlier item", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 0; index < 50; index++) {
      await enqueueRelay({ clientGeneratedId: `flush-capacity-race-${index}` });
    }

    const flush = flushQueue();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await enqueueRelay({ clientGeneratedId: "flush-capacity-race-new" });

    resolveFirst!(ok200());
    await flush;

    const submittedIds = fetchMock.mock.calls.map((call) =>
      JSON.parse(call[1].body as string).clientGeneratedId,
    );
    expect(submittedIds).not.toContain("flush-capacity-race-1");

    const state = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    expect(state.deadLetters.some((item: { report: { clientGeneratedId: string } }) =>
      item.report.clientGeneratedId === "flush-capacity-race-1"
    )).toBe(true);
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

    resolveFirst!(ok200());
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

  it("does not evict a prepared journal-protected pending item on capacity overflow", async () => {
    for (let i = 0; i < 50; i++) {
      await enqueueRelay({ clientGeneratedId: `protected-capacity-${i}` });
    }
    const persisted = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    const protectedItem = persisted.pending[0];
    persisted.journal = [{
      journalId: `journal-${protectedItem.id}`,
      queueItemId: protectedItem.id,
      storageReplica: "co_located",
      baseQueueRevision: persisted.revision,
      clientGeneratedId: protectedItem.report.clientGeneratedId,
      reportFingerprint: "fixture-fingerprint",
      report: protectedItem.report,
      state: "prepared",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }];
    storage.set("mesh_relay_queue", JSON.stringify(persisted));

    const result = await enqueueRelay({ clientGeneratedId: "protected-capacity-new" });

    expect(result).toMatchObject({ accepted: true });
    const saved = storedQueue();
    expect(saved.some((item) => item.report.clientGeneratedId === protectedItem.report.clientGeneratedId && !item.deadLetter)).toBe(true);
    expect(saved.some((item) => item.report.clientGeneratedId === "protected-capacity-new" && !item.deadLetter)).toBe(true);
    expect(saved.some((item) => item.report.clientGeneratedId === protectedItem.report.clientGeneratedId && item.deadLetter)).toBe(false);
    expect(saved.some((item) => item.report.clientGeneratedId === `protected-capacity-1` && item.deadLetter)).toBe(true);
  });

  it("does not keep a delivered journal item as pending during capacity reconciliation", async () => {
    for (let i = 0; i < 50; i++) {
      await enqueueRelay({ clientGeneratedId: `delivered-capacity-${i}` });
    }
    const persisted = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    const deliveredItem = persisted.pending[0];
    persisted.journal = [{
      journalId: `journal-${deliveredItem.id}`,
      queueItemId: deliveredItem.id,
      storageReplica: "co_located",
      baseQueueRevision: persisted.revision,
      clientGeneratedId: deliveredItem.report.clientGeneratedId,
      reportFingerprint: "fixture-fingerprint",
      report: deliveredItem.report,
      state: "delivered",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deliveredAt: Date.now(),
      deliveryDisposition: "http_200",
    }];
    storage.set("mesh_relay_queue", JSON.stringify(persisted));

    const result = await enqueueRelay({ clientGeneratedId: "delivered-capacity-new" });

    expect(result).toMatchObject({ accepted: true });
    const saved = storedQueue();
    expect(saved.some((item) => item.report.clientGeneratedId === deliveredItem.report.clientGeneratedId && !item.deadLetter)).toBe(false);
    expect(saved.some((item) => item.report.clientGeneratedId === "delivered-capacity-new" && !item.deadLetter)).toBe(true);
    expect(saved.some((item) => item.report.clientGeneratedId === deliveredItem.report.clientGeneratedId && item.deadLetter)).toBe(false);
  });

  it("rejects a new item without moving any pending item when all capacity is journal-protected", async () => {
    for (let i = 0; i < 50; i++) {
      await enqueueRelay({ clientGeneratedId: `fully-protected-${i}` });
    }
    const persisted = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    persisted.journal = persisted.pending.map((item: { id: string; report: Record<string, unknown> }) => ({
      journalId: `journal-${item.id}`,
      queueItemId: item.id,
      storageReplica: "co_located",
      baseQueueRevision: persisted.revision,
      clientGeneratedId: item.report.clientGeneratedId,
      reportFingerprint: "fixture-fingerprint",
      report: item.report,
      state: "prepared",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    storage.set("mesh_relay_queue", JSON.stringify(persisted));

    await expect(enqueueRelay({ clientGeneratedId: "fully-protected-new" })).resolves.toEqual({
      accepted: false,
      reason: "queue_capacity_protected",
    });
    const saved = storedQueue();
    expect(saved).toHaveLength(50);
    expect(saved.some((item) => item.report.clientGeneratedId === "fully-protected-new")).toBe(false);
    expect(saved.some((item) => item.deadLetter)).toBe(false);
  });

  it("completes a protected prepared journal after overflow without duplicating it in DLQ", async () => {
    for (let i = 0; i < 50; i++) {
      await enqueueRelay({ clientGeneratedId: `journal-overflow-${i}` });
    }
    const persisted = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    const protectedItem = persisted.pending[0];
    persisted.journal = [{
      journalId: `journal-${protectedItem.id}`,
      queueItemId: protectedItem.id,
      storageReplica: "co_located",
      baseQueueRevision: persisted.revision,
      clientGeneratedId: protectedItem.report.clientGeneratedId,
      reportFingerprint: "fixture-fingerprint",
      report: protectedItem.report,
      state: "prepared",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }];
    storage.set("mesh_relay_queue", JSON.stringify(persisted));
    await enqueueRelay({ clientGeneratedId: "journal-overflow-new" });

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(ok200())
      .mockResolvedValue(new Response(null, { status: 503 })));
    await flushQueue();

    const saved = storedQueue();
    expect(saved.some((item) => item.report.clientGeneratedId === protectedItem.report.clientGeneratedId && item.deadLetter)).toBe(false);
    expect(saved.some((item) => item.report.clientGeneratedId === protectedItem.report.clientGeneratedId)).toBe(false);
    const state = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    expect(state.journal.find((entry: { queueItemId: string }) => entry.queueItemId === protectedItem.id)?.state).toBe("committed");
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
      .mockResolvedValueOnce(ok200())
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
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok200()));
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

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok200()));
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

  it("quarantines legacy pending items without HTTP or journal preparation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    storage.set("mesh_relay_queue", JSON.stringify([{
      id: "legacy-no-origin",
      report: { description: "legacy report without origin id" },
      ts: Date.now(),
      attempts: 0,
      nextAttemptAt: Date.now(),
    }]));

    await flushQueue();

    const saved = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved.pending).toHaveLength(0);
    expect(saved.journal).toHaveLength(0);
    expect(saved.deadLetters).toHaveLength(1);
    expect(saved.deadLetters[0].lastError).toBe("missing_origin_client_generated_id");
  });

  it("does not retry a quarantined legacy item after reload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    storage.set("mesh_relay_queue", JSON.stringify([{
      id: "legacy-reload-no-origin",
      report: {},
      ts: Date.now(),
      attempts: 0,
      nextAttemptAt: Date.now(),
    }]));

    await flushQueue();
    vi.resetModules();
    const { flushQueue: reloadedFlushQueue } = await import("../src/lib/meshRelay.js");
    await reloadedFlushQueue();

    const saved = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved.pending).toHaveLength(0);
    expect(saved.deadLetters[0].lastError).toBe("missing_origin_client_generated_id");
  });

  it("sends a legacy pending item normally when it has a valid origin ID", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok200()));
    vi.stubGlobal("fetch", fetchMock);
    storage.set("mesh_relay_queue", JSON.stringify([{
      id: "legacy-valid-origin",
      report: { clientGeneratedId: "legacy-valid-origin" },
      ts: Date.now(),
      attempts: 0,
      nextAttemptAt: Date.now(),
    }]));

    await flushQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    expect(saved.pending).toHaveLength(0);
    expect(saved.deadLetters).toHaveLength(0);
  });

  it("rejects new enqueue with a missing or invalid origin ID before queue admission", async () => {
    await expect(enqueueRelay({})).resolves.toEqual({
      accepted: false,
      reason: "missing_origin_client_generated_id",
    });
    await expect(enqueueRelay({ clientGeneratedId: "short" })).resolves.toEqual({
      accepted: false,
      reason: "missing_origin_client_generated_id",
    });
    expect(storage.has("mesh_relay_queue")).toBe(false);
  });

  it("preserves a legacy item when its Q1 DLQ transition cannot persist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    storage.set("mesh_relay_queue", JSON.stringify([{
      id: "legacy-dlq-failure",
      report: {},
      ts: Date.now(),
      attempts: 0,
      nextAttemptAt: Date.now(),
    }]));
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    await flushQueue();
    setItem.mockRestore();

    const saved = storedQueue();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0].report.clientGeneratedId).toBeUndefined();
    expect(saved[0].deadLetter).not.toBe(true);
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
