/**
 * Fix 29 (VOL-1): normalizeMaghrebPhone is the canonical wire form — the
 * string the server schema judges, so the client must validate and send
 * exactly this string.
 *
 * Two deliberate readings of the prep doc, recorded here so the reviewer
 * can judge them:
 * - The prep's §3 mapping table governs: every national number becomes
 *   E.164, so `0550 123 456` → `+213550123456` (the §4 shorthand that wrote
 *   `→ 0550123456` describes the stripped intermediate, not the output).
 * - The national shapes collide: DZ, MA and LY all accept 0[567]XXXXXXXX,
 *   so no digit can tell them apart. First match wins in table order, DZ
 *   first — this is an Algerian observatory. A Moroccan national number
 *   therefore normalizes DZ-first (still valid on the wire); a prefixed
 *   +212 number passes through unchanged.
 */
import { describe, it, expect } from "vitest";
import { isValidMaghrebPhone, normalizeMaghrebPhone } from "../src/utils/phone";

describe("normalizeMaghrebPhone (Fix 29 VOL-1)", () => {
  it.each([
    // Finding repros.
    ["0550 123 456", "+213550123456"],
    ["0550-123-456", "+213550123456"],
    ["23456789", "+21623456789"],
    // National forms.
    ["0550123456", "+213550123456"],
    ["0612345678", "+213612345678"], // DZ-first: collides with MA/LY national
    ["0912345678", "+218912345678"],
    // Already-prefixed passthroughs.
    ["+213550123456", "+213550123456"],
    ["+21623456789", "+21623456789"],
    ["+212612345678", "+212612345678"],
    ["+218912345678", "+218912345678"],
    // Fix 29b (CodeRabbit Minor 4): spaced/hyphenated international forms
    // normalize to the same E.164 string — the old fallback returned the
    // raw input with spaces, which validation then rejected.
    ["+213 550 123 456", "+213550123456"],
    ["+216 23 456 789", "+21623456789"],
    ["+213-550-123-456", "+213550123456"],
    ["+218 91 234 5678", "+218912345678"],
    [" 0550123456 ", "+213550123456"],
    // Invalid inputs pass through unchanged (validation rejects them).
    ["aaaaaa", "aaaaaa"],
    ["", ""],
    ["00213550123456", "00213550123456"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeMaghrebPhone(input)).toBe(expected);
  });

  it("the normalized string is what validation judges", () => {
    const valid = ["0550 123 456", "0550-123-456", "23456789", "0550123456", "+213550123456", "+21623456789", "0612345678", "0912345678"];
    for (const input of valid) {
      expect(isValidMaghrebPhone(normalizeMaghrebPhone(input))).toBe(true);
    }
    const invalid = ["aaaaaa", "00213550123456", "12345", "05501234"];
    for (const input of invalid) {
      expect(isValidMaghrebPhone(normalizeMaghrebPhone(input))).toBe(false);
    }
  });
});

describe("normalizeMaghrebPhone country hint (Fix 39 — Fix 29 follow-up)", () => {
  it("a Moroccan hint resolves the 0[567] collision to +212", () => {
    expect(normalizeMaghrebPhone("0612345678", "MA")).toBe("+212612345678");
  });

  it("a Libyan hint resolves the 0[567] collision to +218", () => {
    expect(normalizeMaghrebPhone("0550123456", "LY")).toBe("+218550123456");
  });

  it("an explicit DZ hint is the same as the default DZ-first reading", () => {
    expect(normalizeMaghrebPhone("0550123456", "DZ")).toBe("+213550123456");
  });

  it("an already-prefixed number ignores the hint (control)", () => {
    expect(normalizeMaghrebPhone("+212612345678", "DZ")).toBe("+212612345678");
  });
});
