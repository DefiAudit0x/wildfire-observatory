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

const { enqueueRelay, flushQueue } = await import("../src/lib/meshRelay.js");

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

    enqueueRelay({ clientGeneratedId: "queued-a" });
    const firstFlush = flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    enqueueRelay({ clientGeneratedId: "queued-b" });
    resolveFirst!(new Response(null, { status: 200 }));
    await firstFlush;

    const saved = JSON.parse(storage.get("mesh_relay_queue") || "[]");
    expect(saved).toHaveLength(1);
    expect(saved[0].report.clientGeneratedId).toBe("queued-b");
  });

  it("shares one in-flight flush when online and interval triggers overlap", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(firstResponse);
    vi.stubGlobal("fetch", fetchMock);

    enqueueRelay({ clientGeneratedId: "queued-overlap" });
    const firstFlush = flushQueue();
    const overlappingFlush = flushQueue();
    expect(overlappingFlush).toBe(firstFlush);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst!(new Response(null, { status: 200 }));
    await firstFlush;
    expect(storage.get("mesh_relay_queue")).toBe("[]");
  });
});
