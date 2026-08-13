/**
 * Round-8: meshBridge anti-replay caches must expire by TIME (real 5-minute
 * TTL), not by set size; and the peer poller must notify the empty list.
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

  it("hash is admitted again AFTER the 5-minute TTL", async () => {
    const { checkAndRecordMessageHash } = await import("../src/utils/meshBridge");
    const key = `gossip-after-${Date.now()}`;
    const recordedAt = Date.now();
    expect(checkAndRecordMessageHash(key)).toBe(true);
    vi.setSystemTime(recordedAt + 5 * 60 * 1000 + 1);
    expect(checkAndRecordMessageHash(key)).toBe(true);
  });

  it("nonce is replayable before the TTL window", async () => {
    const { checkAndRecordNonce } = await import("../src/utils/meshBridge");
    expect(checkAndRecordNonce(424242)).toBe(true);
    expect(checkAndRecordNonce(424242)).toBe(false);
  });

  it("nonce is admitted again AFTER the 5-minute TTL", async () => {
    const { checkAndRecordNonce } = await import("../src/utils/meshBridge");
    const recordedAt = Date.now();
    expect(checkAndRecordNonce(434343)).toBe(true);
    vi.setSystemTime(recordedAt + 5 * 60 * 1000 + 1);
    expect(checkAndRecordNonce(434343)).toBe(true);
  });

  it("tracks the authenticated messageId+nonce pair used by browserDecrypt", async () => {
    const { checkAndRecordMessageNonce } = await import("../src/utils/meshBridge");
    expect(checkAndRecordMessageNonce("browser-regression-message", 77)).toBe(true);
    expect(checkAndRecordMessageNonce("browser-regression-message", 77)).toBe(false);
    // A different nonce is a different authenticated message instance.
    expect(checkAndRecordMessageNonce("browser-regression-message", 78)).toBe(true);
  });
});
