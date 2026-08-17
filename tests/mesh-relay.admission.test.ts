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
    return () => undefined;
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

function meshReport(id: string, nonce: number): string {
  return JSON.stringify({
    type: "report",
    lat: 36.75,
    lng: 3.05,
    ts: Date.now(),
    powPrefix: "00000000",
    powNonce: nonce,
    powDifficulty: 8,
    payload: JSON.stringify({
      locationName: "Algiers Forest",
      wilaya: "Algiers",
      description: "Visible wildfire smoke near the northern forest boundary.",
      clientGeneratedId: id,
    }),
  });
}

async function loadRelay() {
  vi.stubGlobal("indexedDB", undefined);
  return import("../src/lib/meshRelay.js");
}

describe("replay digest hardening", () => {
  it("uses a stable full SHA-256 digest rather than a 32-bit replay key", async () => {
    const relay = await loadRelay();
    const first = relay.relayReplayDigest("replay-envelope-a");
    const second = relay.relayReplayDigest("replay-envelope-b");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(relay.relayReplayDigest("replay-envelope-a")).toBe(first);
  });
});

async function fillPending(relay: typeof import("../src/lib/meshRelay.js")) {
  for (let index = 0; index < 50; index++) {
    await relay.enqueueRelay({ clientGeneratedId: `admission-fill-${index}` });
  }
}

function protectAllPending() {
  const state = JSON.parse(storage.get("mesh_relay_queue") || "{}");
  state.journal = state.pending.map((item: { id: string; report: Record<string, unknown> }) => ({
    journalId: `journal-${item.id}`,
    queueItemId: item.id,
    storageReplica: "co_located",
    baseQueueRevision: state.revision,
    clientGeneratedId: item.report.clientGeneratedId,
    reportFingerprint: "fixture-fingerprint",
    report: item.report,
    state: "prepared",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  storage.set("mesh_relay_queue", JSON.stringify(state));
}

function clearProtection() {
  const state = JSON.parse(storage.get("mesh_relay_queue") || "{}");
  state.journal = [];
  storage.set("mesh_relay_queue", JSON.stringify(state));
}

describe("mesh relay replay admission reservations", () => {
  beforeEach(() => {
    storage.clear();
    vi.restoreAllMocks();
    vi.resetModules();
    bridgeMock.handler = null;
    bridgeMock.verifyPoW.mockReset();
    bridgeMock.verifyPoW.mockResolvedValue(true);
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("window", { addEventListener: vi.fn(), setInterval: vi.fn() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("releases a queue_capacity_protected admission so the same raw report can retry", async () => {
    const relay = await loadRelay();
    await fillPending(relay);
    protectAllPending();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    relay.initMeshRelay();
    const raw = meshReport("origin-protected-retry", 1);

    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    clearProtection();
    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(JSON.parse(storage.get("mesh_relay_queue") || "{}").deadLetters).toHaveLength(1));
  });

  it("releases a dead_letter_unavailable admission so the same raw report can retry", async () => {
    const relay = await loadRelay();
    await fillPending(relay);
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    relay.initMeshRelay();
    const raw = meshReport("origin-dlq-retry", 2);

    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    setItem.mockRestore();

    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(JSON.parse(storage.get("mesh_relay_queue") || "{}").deadLetters).toHaveLength(1));
  });

  it("keeps the reservation after volatile acceptance", async () => {
    const relay = await loadRelay();
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    relay.initMeshRelay();
    const raw = meshReport("origin-volatile-accepted", 3);

    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    setItem.mockRestore();
    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.get("mesh_relay_queue")).toBeUndefined();
  });

  it("keeps the reservation when HTTP fails after queue admission", async () => {
    const relay = await loadRelay();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    relay.initMeshRelay();
    const raw = meshReport("origin-http-failure", 4);

    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the reservation when prepared persistence fails after queue admission", async () => {
    const relay = await loadRelay();
    let writes = 0;
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes === 2) throw new Error("quota"); // enqueue → prepared
      storage.set(key, value);
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    relay.initMeshRelay();
    const raw = meshReport("origin-prepared-failure", 5);

    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    setItem.mockRestore();
    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a newer reservation when a stale owner releases", async () => {
    const relay = await loadRelay();
    const raw = meshReport("origin-stale-release", 6);
    const first = relay.reserveRelayHash(raw);
    expect(first).not.toBeNull();
    relay.releaseRelayHash(first!);
    const second = relay.reserveRelayHash(raw);
    expect(second).not.toBeNull();

    relay.releaseRelayHash(first!);
    expect(relay.reserveRelayHash(raw)).toBeNull();
    relay.releaseRelayHash(second!);
    expect(relay.reserveRelayHash(raw)).not.toBeNull();
  });

  it("does not persist an admission reservation across reload", async () => {
    const firstSession = await loadRelay();
    const raw = meshReport("origin-reload-reservation", 7);
    expect(firstSession.reserveRelayHash(raw)).not.toBeNull();

    vi.resetModules();
    const afterReload = await loadRelay();
    expect(afterReload.reserveRelayHash(raw)).not.toBeNull();
  });

  it("rejects a concurrent duplicate while the first admission owns the reservation", async () => {
    const relay = await loadRelay();
    await fillPending(relay);
    protectAllPending();
    let resolvePow: ((value: boolean) => void) | undefined;
    const powResult = new Promise<boolean>((resolve) => { resolvePow = resolve; });
    bridgeMock.verifyPoW.mockReturnValue(powResult);
    relay.initMeshRelay();
    const raw = meshReport("origin-concurrent-admission", 8);

    bridgeMock.handler?.(raw);
    bridgeMock.handler?.(raw);
    await vi.waitFor(() => expect(bridgeMock.verifyPoW).toHaveBeenCalledTimes(2));
    resolvePow!(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    expect(state.pending).toHaveLength(50);
    expect(state.pending.some((item: { report: { clientGeneratedId: string } }) =>
      item.report.clientGeneratedId === "origin-concurrent-admission"
    )).toBe(false);
  });
});
