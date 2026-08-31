import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMock = vi.hoisted(() => ({
  handler: null as ((message: string) => void) | null,
  verifyPoW: vi.fn(),
}));

vi.mock("../src/utils/meshBridge", () => ({
  NETWORK_POW_DIFFICULTY: 8,
  MESH_MESSAGE_TTL_MS: 10 * 60 * 1000,
  MESH_MESSAGE_CLOCK_SKEW_MS: 2 * 60 * 1000,
  isFreshMeshTimestamp: () => true,
  onMeshMessage: (handler: (message: string) => void) => {
    bridgeMock.handler = handler;
    return () => {
      if (bridgeMock.handler === handler) bridgeMock.handler = null;
    };
  },
  verifyPoW: bridgeMock.verifyPoW,
}));

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

function storedState(): {
  pending: Array<{ report: { clientGeneratedId?: string } }>;
  journal: Array<{ state: string; clientGeneratedId: string }>;
} {
  return JSON.parse(storage.get("mesh_relay_queue") || '{"pending":[],"journal":[]}');
}


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

function meshReport(clientGeneratedId?: string, powNonce = 1): string {
  return JSON.stringify({
    type: "report",
    lat: 36.75,
    lng: 3.05,
    ts: Date.now(),
    powPrefix: "00000000",
    powNonce,
    powDifficulty: 8,
    payload: JSON.stringify({
      locationName: "Algiers Forest",
      wilaya: "Algiers",
      description: "Visible wildfire smoke near the northern forest boundary.",
      severity: "high",
      reporterType: "citizen",
      ...(clientGeneratedId ? { clientGeneratedId } : {}),
    }),
  });
}

function malformedMeshMessage(powNonce: number): string {
  return JSON.stringify({
    type: "report",
    lat: 36.75,
    lng: 3.05,
    ts: Date.now(),
    powPrefix: "00000000",
    powNonce,
    powDifficulty: 8,
    payload: JSON.stringify({ locationName: "x" }),
  });
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

describe("mesh relay online ingress journal", () => {
  beforeEach(() => {
    storage.clear();
    vi.restoreAllMocks();
    vi.resetModules();
    bridgeMock.handler = null;
    bridgeMock.verifyPoW.mockReset();
    bridgeMock.verifyPoW.mockResolvedValue(true);
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      setInterval: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("persists prepared before the first online HTTP dispatch and preserves the origin clientGeneratedId", async () => {
    const relay = await loadRelay();
    const fetchMock = vi.fn().mockImplementation(async () => {
      expect(storedState().journal[0]).toMatchObject({ state: "prepared" });
      return ok200();
    });
    vi.stubGlobal("fetch", fetchMock);
    relay.initMeshRelay();

    bridgeMock.handler?.(meshReport("origin-ingress-0001"));

    await vi.waitFor(() => expect(storedState().journal[0]?.state).toBe("committed"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstId = JSON.parse(fetchMock.mock.calls[0][1].body).clientGeneratedId;
    expect(firstId).toBe("origin-ingress-0001");
    expect(storedState().journal[0]?.clientGeneratedId).toBe(firstId);

    vi.resetModules();
    const afterReload = await loadRelay();
    fetchMock.mockClear();
    await afterReload.flushQueue();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a legacy Mesh envelope without origin ID before queue or HTTP", async () => {
    const relay = await loadRelay();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok200()));
    vi.stubGlobal("fetch", fetchMock);
    relay.initMeshRelay();

    bridgeMock.handler?.(meshReport());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedState().pending).toEqual([]);
    expect(storedState().journal).toEqual([]);
  });

  it("retries the same online relay id after HTTP success but crash before delivered persistence", async () => {
    const relay = await loadRelay();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok200())
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "DUPLICATE_CLIENT_GENERATED_ID" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const setItem = failWriteAt(3); // enqueue → prepared → delivered
    relay.initMeshRelay();

    bridgeMock.handler?.(meshReport("origin-retry-0001"));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(storedState().journal[0]?.state).toBe("prepared"));
    const firstId = JSON.parse(fetchMock.mock.calls[0][1].body).clientGeneratedId;

    setItem.mockRestore();
    vi.resetModules();
    const afterReload = await loadRelay();
    await afterReload.flushQueue();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).clientGeneratedId).toBe(firstId);
    expect(storedState().pending).toEqual([]);
    expect(storedState().journal[0]?.state).toBe("committed");
  });

  it("does not let PoW-valid malformed payloads exhaust replay capacity before a valid report", async () => {
    const relay = await loadRelay();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok200()));
    vi.stubGlobal("fetch", fetchMock);
    relay.initMeshRelay();

    for (let nonce = 0; nonce < 2000; nonce++) {
      bridgeMock.handler?.(malformedMeshMessage(nonce));
    }
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(2000));
    await new Promise((resolve) => setTimeout(resolve, 0));

    bridgeMock.handler?.(meshReport("origin-valid-after-poison-0001", 2001));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
