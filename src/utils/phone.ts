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
