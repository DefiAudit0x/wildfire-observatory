/**
 * v2.6.0 — S-M12: GENERAL_LIMIT_MAX validation.
 * "abc" used to become NaN and "0" became 0 — both handed straight to
 * express-rate-limit as the request ceiling (bricking every request or
 * disabling the limiter). Malformed values now fall back to 100 with a
 * boot-time warning.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const ORIGINAL = process.env.GENERAL_LIMIT_MAX;
const ORIGINAL_PORT = process.env.PORT;

async function loadConfig(value: string | undefined): Promise<number> {
  vi.resetModules();
  if (value === undefined) delete process.env.GENERAL_LIMIT_MAX;
  else process.env.GENERAL_LIMIT_MAX = value;
  const mod = await import("../server/config.js");
  return mod.default.generalLimitMax;
}

async function loadPort(value: string | undefined): Promise<number> {
  vi.resetModules();
  if (value === undefined) delete process.env.PORT;
  else process.env.PORT = value;
  const mod = await import("../server/config.js");
  return mod.default.port;
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GENERAL_LIMIT_MAX;
  else process.env.GENERAL_LIMIT_MAX = ORIGINAL;
  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;
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

describe("v2.15.0: PORT validation (parsePort no longer prefix-parses)", () => {
  it("falls back to 3000 for prefix-parsed garbage like 3000px", async () => {
    expect(await loadPort("3000px")).toBe(3000);
  });

  it("falls back to 3000 for non-integers like 3000.5", async () => {
    expect(await loadPort("3000.5")).toBe(3000);
  });

  it("honors a valid port", async () => {
    expect(await loadPort("4567")).toBe(4567);
  });

  it("rejects out-of-range values", async () => {
    expect(await loadPort("0")).toBe(3000);
    expect(await loadPort("70000")).toBe(3000);
    expect(await loadPort("-1")).toBe(3000);
  });
});
