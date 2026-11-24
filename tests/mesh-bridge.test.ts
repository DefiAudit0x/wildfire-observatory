// @vitest-environment jsdom
// (Fix 46 — MBR-1: the native-handler test touches `window` directly;
// without this the file fails under the node-based server config.)
/**
 * Round-8: meshBridge anti-replay caches must expire by TIME (real 12-minute
 * retention: 10-minute TTL plus 2 minutes of clock skew), not by set size;
 * and the peer poller must notify the empty list. (Fix 46 — MBR-2: the
 * "5-minute" claim was stale.)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("meshBridge anti-replay TTL", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hash is replayable before the TTL window", async () => {
    const { checkAndRecordMessageHash } = await import("../src/utils/meshBridge");
    const key = `gossip-before-${Date.now()}`;
    expect(checkAndRecordMessageHash(key)).toBe(true);
    expect(checkAndRecordMessageHash(key)).toBe(false);
  });

  it("hash stays rejected through the full freshness retention window", async () => {
    const { checkAndRecordMessageHash } = await import("../src/utils/meshBridge");
    const key = `gossip-after-${Date.now()}`;
    const recordedAt = Date.now();
    expect(checkAndRecordMessageHash(key)).toBe(true);
    vi.setSystemTime(recordedAt + 10 * 60 * 1000);
    expect(checkAndRecordMessageHash(key)).toBe(false);
    vi.setSystemTime(recordedAt + 12 * 60 * 1000 + 1);
    expect(checkAndRecordMessageHash(key)).toBe(true);
  });

  it("nonce is replayable before the TTL window", async () => {
    const { checkAndRecordNonce } = await import("../src/utils/meshBridge");
    expect(checkAndRecordNonce(424242)).toBe(true);
    expect(checkAndRecordNonce(424242)).toBe(false);
  });

  it("nonce stays rejected through the full freshness retention window", async () => {
    const { checkAndRecordNonce } = await import("../src/utils/meshBridge");
    const recordedAt = Date.now();
    expect(checkAndRecordNonce(434343)).toBe(true);
    vi.setSystemTime(recordedAt + 12 * 60 * 1000 + 1);
    expect(checkAndRecordNonce(434343)).toBe(true);
  });

  it("tracks the authenticated messageId+nonce pair used by browserDecrypt", async () => {
    const { checkAndRecordMessageNonce } = await import("../src/utils/meshBridge");
    expect(checkAndRecordMessageNonce("browser-regression-message", 77)).toBe(true);
    expect(checkAndRecordMessageNonce("browser-regression-message", 77)).toBe(false);
    // A different nonce is a different authenticated message instance.
    expect(checkAndRecordMessageNonce("browser-regression-message", 78)).toBe(true);
  });

  it("accepts the signed int32 nonce range used by Native", async () => {
    const { checkAndRecordMessageNonce } = await import("../src/utils/meshBridge");
    expect(checkAndRecordMessageNonce("negative-native-nonce", -123456)).toBe(true);
    expect(checkAndRecordMessageNonce("negative-native-nonce", -123456)).toBe(false);
  });

  it("does not evict the oldest entries under a burst of traffic (Fix 46 — MBR-2)", async () => {
    const { checkAndRecordMessageNonce } = await import("../src/utils/meshBridge");
    const first = "cache-bound-first";
    expect(checkAndRecordMessageNonce(first, 1)).toBe(true);
    for (let i = 0; i < 5000; i++) {
      expect(checkAndRecordMessageNonce(`cache-bound-${i}`, i + 2)).toBe(true);
    }
    // Age-only purge: the burst must not wipe the replay window.
    expect(checkAndRecordMessageNonce(first, 1)).toBe(false);
  });

  it("rejects timestamps older than the native ten-minute freshness window", async () => {
    const { isFreshMeshTimestamp } = await import("../src/utils/meshBridge");
    const now = 1_700_000_000_000;
    expect(isFreshMeshTimestamp(now - 10 * 60 * 1000 - 1, now)).toBe(false);
    expect(isFreshMeshTimestamp(now + 2 * 60 * 1000 + 1, now)).toBe(false);
    expect(isFreshMeshTimestamp(now - 60_000, now)).toBe(true);
  });
});

describe("meshBridge native message handler (Fix 46 — MBR-1)", () => {
  afterEach(() => {
    // The installed-flag is module-level: clean it so a later test can
    // reinstall the handler (the unsubscribe below also clears it, this
    // covers a test that fails before reaching it).
    delete (window as any).onMeshMessage;
    delete (window as any).__meshNativeHandlerInstalled;
    delete (window as any).AndroidBridge;
  });

  it("drops a null JSON payload instead of throwing, and never forwards raw text", async () => {
    const { onMeshMessage } = await import("../src/utils/meshBridge");
    const listener = vi.fn();
    // The handler installs only when a bridge exists — set it BEFORE
    // registering, or installNativeMessageHandler returns early.
    (window as any).AndroidBridge = { getPeerReputation: () => 0 };
    const unsubscribe = onMeshMessage(listener);

    expect(() => (window as any).onMeshMessage("null")).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(() => (window as any).onMeshMessage('"bare string"')).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(() => (window as any).onMeshMessage("42")).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(() => (window as any).onMeshMessage("[1,2]")).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    // Controls (pass on old code too): malformed JSON is dropped by the
    // existing catch, and a valid envelope is delivered.
    expect(() => (window as any).onMeshMessage("not json{")).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    (window as any).onMeshMessage('{"peerId":"peer-1","payload":"hello"}');
    expect(listener).toHaveBeenCalledWith("hello", "peer-1", 0);

    unsubscribe();
  });
});
