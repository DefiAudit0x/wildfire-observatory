// @vitest-environment jsdom
/**
 * Fix 38 (API-2): cacheGet's ttlMs parameter was dead — the stored absolute
 * expiry is the only thing checked. The parameter is removed; these specs pin
 * the retained behavior (stored-expiry honored, missing/corrupt → null).
 * There is no fail-without-fix test for the removal itself: the old code
 * passes all of these — the defect is proven by repo-wide grep (zero
 * callers) + tsc (no call site passes a second argument).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { cacheGet, cacheSet } from "../src/utils/api";

beforeEach(() => {
  localStorage.clear();
});

describe("cacheGet/cacheSet", () => {
  it("round-trips a value set by cacheSet", () => {
    cacheSet("k1", { a: 1 });
    expect(cacheGet<{ a: number }>("k1")).toEqual({ a: 1 });
  });

  it("returns null and removes the key once the stored expiry passed", () => {
    cacheSet("k2", "v", -1);
    expect(cacheGet("k2")).toBeNull();
    expect(localStorage.getItem("k2")).toBeNull();
  });

  it("returns null for a missing key and for corrupt stored JSON", () => {
    expect(cacheGet("nope")).toBeNull();
    localStorage.setItem("bad", "{not json");
    expect(cacheGet("bad")).toBeNull();
  });
});
