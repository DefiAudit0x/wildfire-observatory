/**
 * v2.6.0 — S-M12: GENERAL_LIMIT_MAX validation.
 * "abc" used to become NaN and "0" became 0 — both handed straight to
 * express-rate-limit as the request ceiling (bricking every request or
 * disabling the limiter). Malformed values now fall back to 100 with a
 * boot-time warning.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const ORIGINAL = process.env.GENERAL_LIMIT_MAX;

async function loadConfig(value: string | undefined): Promise<number> {
  vi.resetModules();
  if (value === undefined) delete process.env.GENERAL_LIMIT_MAX;
  else process.env.GENERAL_LIMIT_MAX = value;
  const mod = await import("../server/config.js");
  return mod.default.generalLimitMax;
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GENERAL_LIMIT_MAX;
  else process.env.GENERAL_LIMIT_MAX = ORIGINAL;
});

describe("S-M12: GENERAL_LIMIT_MAX validation", () => {
  it("defaults to 100 when unset", async () => {
    expect(await loadConfig(undefined)).toBe(100);
  });

  it("falls back to 100 for NaN garbage", async () => {
    expect(await loadConfig("abc")).toBe(100);
  });

  it("falls back to 100 for 0 (would have disabled the limiter)", async () => {
    expect(await loadConfig("0")).toBe(100);
  });

  it("falls back to 100 for negatives and non-integers", async () => {
    expect(await loadConfig("-5")).toBe(100);
    expect(await loadConfig("12.5")).toBe(100);
  });

  it("honors a valid override", async () => {
    expect(await loadConfig("150")).toBe(150);
  });
});
