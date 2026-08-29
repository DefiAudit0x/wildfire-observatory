/**
 * Firestore boundary sanitizer (ARC-C1/C2 fix).
 *
 * Firestore rejects any `undefined` value (directly or nested) with
 * "Cannot use 'undefined' as a Firestore value". Several routes build
 * payloads with conditionally-absent keys (optional badge fields, missing
 * assigned code, absent PII). Instead of repeating conditional-spread logic
 * in every route, every durable write path strips undefined values at the
 * boundary — the write layer becomes total and route-level 503s caused by
 * ad-hoc payload building disappear.
 *
 * Semantics:
 *  - Plain objects (and their nested children): `undefined` keys are dropped.
 *  - Arrays: `undefined` members are dropped (Firestore cannot store holes);
 *    member order is otherwise preserved.
 *  - Class instances (Firestore `FieldValue`, `Timestamp`, `Date`, buffers…)
 *    are returned untouched so sentinel values like arrayUnion/increment
 *    survive the pass.
 */
export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const normalized: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child === undefined) continue;
        normalized[key] = stripUndefinedDeep(child);
      }
      return normalized as unknown as T;
    }
  }
  return value;
}
