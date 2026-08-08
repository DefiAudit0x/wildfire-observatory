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
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  try {
    const req = (event as { request?: { data?: unknown } }).request;
    if (req?.data) {
      try {
        const parsed = typeof req.data === "string" ? JSON.parse(req.data) : req.data;
        if (parsed && typeof parsed === "object") {
          const clean: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            clean[k] = SENSITIVE_FIELDS.has(k) ? "[redacted]" : v;
          }
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
        }
      }
    }
  } catch {
    /* never let scrubbing break error reporting */
  }
  return event;
}