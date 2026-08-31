/**
 * ARC-L21: the JSON admin/staff fetch helper used to be copied verbatim into
 * three panels (BadgeManager, SafeZonesManager, StaffManager) — three copies
 * that could drift on credentials policy or header handling. This module is
 * the single copy, and it also owns the one session-expiry classifier every
 * admin/staff surface routes 401s through (ARC-M33: one session truth).
 */

const API_FETCH_TIMEOUT_MS = 15_000;

export async function apiFetch(url: string, method: string, body?: unknown): Promise<Response> {
  // ARC-R7: none of these surfaces had a request ceiling — one hung link kept
  // busy-flags set for minutes (same lesson as TrappedSOSModal H11 and the
  // mesh relay H5). 15s matches the house precedent; an abort surfaces as a
  // network error in every caller's catch, which already shows a failure chip.
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(API_FETCH_TIMEOUT_MS)
      : undefined;
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

/**
 * ARC-M33: the server's documented semantics — 401 means the session cookie
 * is missing/expired (session death), 403 means an authenticated caller whose
 * role is insufficient (a role error, NOT a logout). Surfaces used to disagree
 * (one treated 401||403 as expiry and killed valid sessions on role errors,
 * another ignored both); every surface now routes 401 here.
 */
export function isSessionExpiry(res: Response): boolean {
  return res.status === 401;
}
