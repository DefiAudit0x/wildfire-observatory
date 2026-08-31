import type { ErrorEvent } from "@sentry/node";

const SENSITIVE_FIELDS = new Set([
  "imageBase64",
  "image",
  "photo",
  "audioData",
  "audio",
  "sosAudio",
  "deviceId",
  "phone",
  "email",
  "name",
  "lastName",
  "firstName",
]);

/**
 * Redacts PII (images, audio, device ids, contacts) from Sentry events
 * before they leave the server. Falls back to full-body redaction if the
 * request body cannot be parsed. Never throws.
 */
/**
 * ARC-L07: the scrub used to be one level deep — a body shaped like
 * { report: { phone: ... } } slipped past because "phone" was nested inside
 * "report" while only TOP-LEVEL keys were compared against SENSITIVE_FIELDS.
 * Now the walk is recursive (bounded depth so a hostile body cannot turn the
 * error path itself into a DoS), and the same key regexes apply at every level.
 */
const MAX_SCRUB_DEPTH = 8;

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > MAX_SCRUB_DEPTH) return "[redacted-depth]";
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      clean[k] = SENSITIVE_FIELDS.has(k) || /image|audio|base64|device|phone|email/i.test(k)
        ? "[redacted]"
        : scrubValue(v, depth + 1);
    }
    return clean;
  }
  return value;
}

export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  try {
    const req = (event as { request?: { data?: unknown } }).request;
    if (req?.data) {
      try {
        const parsed = typeof req.data === "string" ? JSON.parse(req.data) : req.data;
        if (parsed && typeof parsed === "object") {
          const clean = scrubValue(parsed, 0);
          req.data = typeof req.data === "string" ? JSON.stringify(clean) : clean;
        }
      } catch {
        req.data = "[redacted]";
      }
    }
    if (event.extra) {
      for (const key of Object.keys(event.extra)) {
        if (SENSITIVE_FIELDS.has(key) || /image|audio|base64|device|phone|email/i.test(key)) {
          event.extra[key] = "[redacted]";
        } else {
          event.extra[key] = scrubValue(event.extra[key], 0);
        }
      }
    }
  } catch {
    /* never let scrubbing break error reporting */
  }
  return event;
}