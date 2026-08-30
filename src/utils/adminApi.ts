/**
 * ARC-L21: the JSON admin/staff fetch helper used to be copied verbatim into
 * three panels (BadgeManager, SafeZonesManager, StaffManager) — three copies
 * that could drift on credentials policy or header handling. This module is
 * the single copy, and it also owns the one session-expiry classifier every
 * admin/staff surface routes 401s through (ARC-M33: one session truth).
 */

export async function apiFetch(url: string, method: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: body ? JSON.stringify(body) : undefined,
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
