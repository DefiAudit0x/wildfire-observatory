import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const report = (id: string) => ({
  clientGeneratedId: id,
  lat: 36.75,
  lng: 7.6,
  locationName: "غابة اختبار",
  wilaya: "الطارف",
  description: "حريق اختباري طويل بما يكفي لاجتياز مخطط التقرير",
  severity: "medium",
  reporterType: "citizen",
});

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  };
}

describe("F-013 — flushQueue/enqueueRelay persistence races", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("preserves an enqueue that races an in-flight flush when final reconciliation persistence fails", async () => {
    const { enqueueRelay, flushQueue } = await import("../src/lib/meshRelay.js");
    const first = report(`f013-first-${Date.now()}`);
    const second = report(`f013-second-${Date.now()}`);

    let releaseFirstRequest!: () => void;
    let firstRequestStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstRequestStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirstRequest = resolve; });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      firstRequestStarted();
      await firstRelease;
      return { status: 200, json: async () => ({}) } as Response;
    });

    const storage = globalThis.localStorage as ReturnType<typeof createMemoryStorage>;
    const originalSetItem = storage.setItem;
    const setItem = vi.spyOn(storage, "setItem").mockImplementation(function (key: string, value: string) {
      if (key === "mesh_relay_queue") {
        try {
          const state = JSON.parse(value);
          const finalReconciliation =
            Array.isArray(state.pending) &&
            state.pending.length === 1 &&
            Array.isArray(state.journal) &&
            state.journal.some((entry: any) => entry.state === "delivered");
          if (finalReconciliation) throw new Error("F-013 simulated localStorage failure");
        } catch (error) {
          if (error instanceof Error && error.message === "F-013 simulated localStorage failure") throw error;
        }
      }
      return originalSetItem(key, value);
    });

    await expect(enqueueRelay(first)).resolves.toMatchObject({ accepted: true });
    const flush = flushQueue();
    await firstStarted;

    // The second enqueue occurs while the first report is waiting on HTTP.
    // It must not be lost when the flush later reconciles against a newer queue snapshot.
    await expect(enqueueRelay(second)).resolves.toMatchObject({ accepted: true });
    releaseFirstRequest();
    await flush;

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The failed final reconciliation leaves the newer item in volatile authoritative
    // storage, while the delivered journal prevents the first report from replaying.
    await flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      body: expect.stringContaining(second.clientGeneratedId),
    });
    expect(setItem).toHaveBeenCalled();
  });

  it("does not claim persistence when localStorage is unavailable during enqueue", async () => {
    const { enqueueRelay, flushQueue } = await import("../src/lib/meshRelay.js");
    const storage = globalThis.localStorage as ReturnType<typeof createMemoryStorage>;
    vi.spyOn(storage, "setItem").mockImplementation(function () {
      throw new Error("F-013 simulated localStorage outage");
    });

    const result = await enqueueRelay(report(`f013-volatile-${Date.now()}`));
    expect(result).toEqual({ accepted: true, storage: "volatile" });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ status: 200 } as Response);
    await flushQueue();

    // Without durable storage the journal cannot become prepared, so no HTTP
    // delivery is claimed. The item remains volatile rather than being discarded.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
