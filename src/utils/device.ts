/**
 * Device identity for authenticated device-scoped features (notifications,
 * report ownership, confirmations, SOS identity).
 *
 * Privacy semantics (kept explicit for the future privacy review):
 * - It is NOT a personal identifier: no name, email or phone is derived from
 *   it, and it carries no serial or hardware binding.
 * - It IS persistent: stored in localStorage, so it survives reloads — that is
 *   what keeps "your" notifications and unread state stable across tabs.
 * - It is rotated when the browser storage is cleared; clearing storage is
 *   the documented way to start fresh. Session storage mirrors it per tab.
 * - Server-side it appears only as a lookup key for per-device data and is
 *   never exposed in public DTOs (see the PII-safe public report/sos DTOs).
 */

let memoryDeviceId: string | null = null;
let fallbackCounter = 0;

function newDeviceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `web_${uuid}`;
  fallbackCounter += 1;
  return `web_${Date.now()}_${fallbackCounter}`;
}

export function getDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;

  let sessionId: string | null = null;
  let storedId: string | null = null;
  try {
    sessionId = sessionStorage.getItem("device_id");
    storedId = localStorage.getItem("device_id");
  } catch {
    // Storage may be disabled or unavailable; keep a session-scoped memory ID.
  }

  const id = sessionId || storedId || newDeviceId();
  memoryDeviceId = id;

  try {
    sessionStorage.setItem("device_id", id);
    localStorage.setItem("device_id", id);
  } catch {
    // Storage unavailable — memoryDeviceId keeps the ID stable for this page.
  }

  return id;
}
