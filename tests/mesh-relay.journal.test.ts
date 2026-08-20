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

type StoredState = {
  revision: number;
  pending: Array<{ report: { clientGeneratedId: string } }>;
  journal: Array<{ state: string; clientGeneratedId: string }>;
};

function storedState(): StoredState {
  return JSON.parse(storage.get("mesh_relay_queue") || '{"pending":[],"journal":[]}') as StoredState;
}

async function loadRelay(indexedDb: IDBFactory | undefined = undefined) {
  vi.stubGlobal("indexedDB", indexedDb);
  return import("../src/lib/meshRelay.js");
}

function failWriteAt(targetCall: number) {
  let calls = 0;
  return vi.spyOn(globalThis.localStorage, "setItem").mockImplementation((key, value) => {
    calls += 1;
    if (calls === targetCall) throw new Error("quota");
    storage.set(key, value);
  });
}

function replicaState(revision: number, journalState: "prepared" | "delivered" | "committed") {
  const now = Date.now();
  const report = { clientGeneratedId: "replica-divergence-a" };
  const item = {
    id: "replica-item-a",
    report,
    ts: now,
    attempts: 0,
    nextAttemptAt: 0,
  };
  const fingerprint = (() => {
    const raw = JSON.stringify(report);
    let hash = 5381;
    for (let index = 0; index < raw.length; index++) hash = ((hash << 5) + hash + raw.charCodeAt(index)) | 0;
    return String(hash >>> 0);
  })();
  return {
    revision,
    pending: [item],
    deadLetters: [],
    journal: [{
      journalId: "journal-replica-item-a",
      queueItemId: item.id,
      storageReplica: "co_located",
      baseQueueRevision: revision,
      clientGeneratedId: report.clientGeneratedId,
      reportFingerprint: fingerprint,
      report,
      state: journalState,
      createdAt: now,
      updatedAt: now,
      deliveredAt: journalState === "prepared" ? undefined : now,
      deliveryDisposition: journalState === "prepared" ? undefined : "http_200",
    }],
  };
}

function indexedDbWithState(initialState: unknown): IDBFactory {
  let stored = initialState;
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction: () => {
      const transaction: {
        objectStore: () => typeof objectStore;
        abort: () => void;
        oncomplete?: () => void;
        onabort?: () => void;
        onerror?: () => void;
      } = {
        objectStore: () => objectStore,
        abort: () => queueMicrotask(() => transaction.onabort?.()),
      };
      const objectStore = {
        get: (key: string) => {
          const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
          queueMicrotask(() => {
            request.result = key === "state" ? stored : undefined;
            request.onsuccess?.();
          });
          return request;
        },
        put: (value: unknown) => {
          const request: { onsuccess?: () => void; onerror?: () => void } = {};
          queueMicrotask(() => {
            stored = value;
            request.onsuccess?.();
            transaction.oncomplete?.();
          });
          return request;
        },
      };
      return transaction;
    },
  };
  return {
    open: () => {
      const request: { result: typeof db; onsuccess?: () => void; onupgradeneeded?: () => void } = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  } as unknown as IDBFactory;
}

async function expectTerminalReplicaSuppressesNewerPending(indexedState: unknown, localState: unknown) {
  storage.set("mesh_relay_queue", JSON.stringify(localState));
  const indexedDb = indexedDbWithState(indexedState);
  const relay = await loadRelay(indexedDb);
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await relay.flushQueue();

  expect(fetchMock).not.toHaveBeenCalled();
  expect(storedState().pending).toEqual([]);
  expect(storedState().journal[0]?.state).toBe("committed");

  vi.resetModules();
  const afterReload = await loadRelay(indexedDb);
  fetchMock.mockClear();
  await afterReload.flushQueue();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(storedState().pending).toEqual([]);
  expect(storedState().journal[0]?.state).toBe("committed");
}

describe("mesh relay durable reconciliation journal", () => {
  beforeEach(() => {
    storage.clear();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.stubGlobal("indexedDB", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not dispatch HTTP when durable prepared persistence fails", async () => {
    const relay = await loadRelay();
    await relay.enqueueRelay({ clientGeneratedId: "journal-prepared-failure" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    await relay.flushQueue();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedState().pending.map((item) => item.report.clientGeneratedId))
      .toEqual(["journal-prepared-failure"]);
    expect(storedState().journal).toEqual([]);
    setItem.mockRestore();
  });

  it("rebuilds delivered state after reload when queue persistence fails", async () => {
    const relay = await loadRelay();
    await relay.enqueueRelay({ clientGeneratedId: "journal-delivered-before-queue" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const setItem = failWriteAt(3); // prepared → delivered → queue transition

    await relay.flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storedState().pending).toHaveLength(1);
    expect(storedState().journal[0]?.state).toBe("delivered");

    setItem.mockRestore();
    vi.resetModules();
    const afterReload = await loadRelay();
    fetchMock.mockClear();
    await afterReload.flushQueue();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedState().pending).toEqual([]);
    expect(storedState().journal[0]?.state).toBe("committed");
  });

  it("retries the same clientGeneratedId after crash between HTTP and delivered", async () => {
    const relay = await loadRelay();
    await relay.enqueueRelay({ clientGeneratedId: "journal-retry-same-client-id" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const setItem = failWriteAt(2); // prepared → delivered

    await relay.flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storedState().journal[0]?.state).toBe("prepared");

    setItem.mockRestore();
    vi.resetModules();
    const afterReload = await loadRelay();
    fetchMock.mockClear();
    await afterReload.flushQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).clientGeneratedId)
      .toBe("journal-retry-same-client-id");
    expect(storedState().pending).toEqual([]);
    expect(storedState().journal[0]?.state).toBe("committed");
  });

  it("resumes committed finalization after crash between queue commit and journal commit", async () => {
    const relay = await loadRelay();
    await relay.enqueueRelay({ clientGeneratedId: "journal-commit-finalization" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const setItem = failWriteAt(4); // prepared → delivered → queue transition → committed

    await relay.flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storedState().pending).toEqual([]);
    expect(storedState().journal[0]?.state).toBe("delivered");

    setItem.mockRestore();
    vi.resetModules();
    const afterReload = await loadRelay();
    fetchMock.mockClear();
    await afterReload.flushQueue();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedState().journal[0]?.state).toBe("committed");
  });

  it("lets a delivered journal win over a newer pending replica", async () => {
    await expectTerminalReplicaSuppressesNewerPending(
      replicaState(12, "delivered"),
      replicaState(13, "prepared")
    );
  });

  it("lets a delivered journal win over a newer pending replica in the opposite storage order", async () => {
    await expectTerminalReplicaSuppressesNewerPending(
      replicaState(13, "prepared"),
      replicaState(12, "delivered")
    );
  });

  it("does not treat a newer prepared replica as terminal when no replica delivered", async () => {
    storage.set("mesh_relay_queue", JSON.stringify(replicaState(13, "prepared")));
    const indexedDb = indexedDbWithState(replicaState(12, "prepared"));
    const relay = await loadRelay(indexedDb);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await relay.flushQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).clientGeneratedId)
      .toBe("replica-divergence-a");
    expect(storedState().pending).toEqual([]);
    expect(storedState().journal[0]?.state).toBe("committed");
  });
});
