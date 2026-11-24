/**
 * ARC-L17: the ONE phone-validation policy module. Previously three citizen
 * windows carried three different (or missing) phone policies for the same
 * citizen phone field — they all live here now.
 *
 * Two modes, each preserving the pre-existing behavior of its caller:
 *  - isValidMaghrebPhone: strict Maghreb mobile/landline (DZ/TN/MA/LY) — used
 *    by VolunteerRegistration where the field is REQUIRED.
 *  - isValidOptionalPhone: generic permissive shape — used by ReportForm where
 *    the field is OPTIONAL and must never block a report.
 * TrappedSOSModal deliberately validates NOTHING: the SOS path is life-safety
 * and must accept any string the operator's keyboard produces.
 */

const PHONE_DZ = /^(?:\+213|0)(5|6|7)\d{8}$/;
const PHONE_TN = /^(?:\+216)?[2-9]\d{7}$/;
const PHONE_MA = /^(?:\+212|0)(?:5|6|7)\d{8}$/;
const PHONE_LY = /^(?:\+218|0)[2-9]\d{8}$/;

/** Strict Maghreb policy (Algeria, Tunisia, Morocco, Libya). */
export function isValidMaghrebPhone(value: string): boolean {
  const v = value.trim();
  return PHONE_DZ.test(v) || PHONE_TN.test(v) || PHONE_MA.test(v) || PHONE_LY.test(v);
}

/**
 * Fix 29 (VOL-1): canonical wire form — strip spaces/hyphens, then express
 * every national number in E.164. This is the string the server schema
 * judges, so the client must validate and send exactly this string, never
 * the raw input. Already-prefixed numbers pass through unchanged. Returns
 * the input unchanged when it matches no national pattern (validation
 * rejects it). `00`-prefixed input matches no client regex today and is
 * rejected before normalization matters — no `00` rule is added.
 *
 * Fix 39 (Fix 29 follow-up): DZ, MA and LY all accept `0[567]XXXXXXXX`,
 * so a bare 05/06/07 number is ambiguous. An optional country hint from
 * the selected wilaya resolves ONLY that collision (hint MA → +212, hint
 * LY → +218); without a hint the table keeps its DZ-first order. The hint
 * never touches prefixed numbers (they pass through before the table) or
 * the Tunisian 8-digit shape (it collides with nothing).
 */
export function normalizeMaghrebPhone(value: string, countryHint?: "DZ" | "TN" | "MA" | "LY"): string {
  const v = value.replace(/[\s\-]/g, "");
  const collision = /^0([567])(\d{8})$/.exec(v);
  if (collision) {
    if (countryHint === "MA") return `+212${collision[1]}${collision[2]}`;
    if (countryHint === "LY") return `+218${collision[1]}${collision[2]}`;
    return `+213${collision[1]}${collision[2]}`;
  }
  const tn = /^([2-9])(\d{7})$/.exec(v);
  if (tn) return `+216${tn[1]}${tn[2]}`;
  const ly = /^0([2-9])(\d{8})$/.exec(v);
  if (ly) return `+218${ly[1]}${ly[2]}`;
  // Fix 29b (CodeRabbit Minor 4): return the STRIPPED candidate, not the
  // raw input — `+213 550 123 456` is a valid number with spaces, and
  // ` +213550123456 ` passed validation (trim) but was submitted with
  // spaces, so the server rejected it. For genuinely invalid input v is
  // identical to value unless it carries spaces/hyphens, which validation
  // rejects either way.
  return v;
}

const GENERIC_PHONE = /^\+?[0-9][0-9 ()-]{5,29}$/;

/**
 * Optional-field policy: empty/whitespace is VALID (the caller treats an
 * absent phone as "no phone"); a present value must be a plausible number.
 */
export function isValidOptionalPhone(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  return GENERIC_PHONE.test(v);
}
