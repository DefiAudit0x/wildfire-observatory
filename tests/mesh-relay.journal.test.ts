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
  pending: Array<{ report: { clientGeneratedId: string } }>;
  journal: Array<{ state: string; clientGeneratedId: string }>;
};

function storedState(): StoredState {
  return JSON.parse(storage.get("mesh_relay_queue") || '{"pending":[],"journal":[]}') as StoredState;
}

async function loadRelay() {
  vi.stubGlobal("indexedDB", undefined);
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
});
