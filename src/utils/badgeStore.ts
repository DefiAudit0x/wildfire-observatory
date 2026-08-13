/**
 * Session-only convenience state for a server-validated reporter badge.
 * This is never an authorization source: the server response is the authority,
 * and ReportForm writes here only after receiving status === "verified".
 */
export const REPORTER_BADGE_KEY = "reporterBadgeCode";
export const BADGE_CHANGED_EVENT = "badge-changed";

export function getReporterBadge(): string | null {
  try {
    return sessionStorage.getItem(REPORTER_BADGE_KEY);
  } catch {
    return null;
  }
}

export function setReporterBadge(code: string): void {
  try {
    sessionStorage.setItem(REPORTER_BADGE_KEY, code);
    // Remove the old durable copy created by previous releases.
    localStorage.removeItem(REPORTER_BADGE_KEY);
    window.dispatchEvent(new Event(BADGE_CHANGED_EVENT));
  } catch {
    // Storage unavailable — the badge applies to this session only.
  }
}

export function subscribeReporterBadge(callback: () => void): () => void {
  window.addEventListener(BADGE_CHANGED_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(BADGE_CHANGED_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}
