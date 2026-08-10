/**
 * Device identity for authenticated device-scoped features (notifications,
 * report ownership, confirmations, SOS identity).
 *
 * Privacy semantics (kept explicit for the future privacy review):
 * - It is NOT a personal identifier: no name, email or phone is derived from
 *   it, and it carries no serial or hardware binding.
 * - It IS persistent: stored in localStorage, so it survives reloads — that
 *   is what keeps "your" notifications and unread state stable across tabs.
 * - It is rotated when the browser storage is cleared; clearing storage is
 *   the documented way to start fresh. Session storage mirrors it per tab.
 * - Server-side it appears only as a lookup key for per-device data and is
 *   never exposed in public DTOs (see the PII-safe public report/sos DTOs).
 */
export function getDeviceId(): string {
  const sessionId = sessionStorage.getItem("device_id");
  const storedId = localStorage.getItem("device_id");
  let id = sessionId || storedId;
  if (!id) {
    id = `web_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
  }
  sessionStorage.setItem("device_id", id);
  localStorage.setItem("device_id", id);
  return id;
}