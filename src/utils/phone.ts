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
 */
export function normalizeMaghrebPhone(value: string): string {
  const v = value.replace(/[\s\-]/g, "");
  // The national shapes collide: DZ, MA and LY all accept 0[567]XXXXXXXX,
  // so no digit can tell them apart. First match wins in the table order
  // below, DZ first — this is an Algerian observatory, and a prefixed
  // +212/+218 number still passes through unchanged (see the end).
  const dz = /^0([567])(\d{8})$/.exec(v);
  if (dz) return `+213${dz[1]}${dz[2]}`;
  const tn = /^([2-9])(\d{7})$/.exec(v);
  if (tn) return `+216${tn[1]}${tn[2]}`;
  const ly = /^0([2-9])(\d{8})$/.exec(v);
  if (ly) return `+218${ly[1]}${ly[2]}`;
  return value;
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
