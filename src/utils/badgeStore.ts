/**
 * Single source of truth for the device's reporter badge code. Nothing else
 * writes this key directly: ReportForm persists it (via setReporterBadge) on
 * a SUCCESSFUL submission only, and every consumer (App's trusted-reporter
 * gate, the location heartbeat) reads it here.
 *
 * Session reactivity: the storage event alone cannot wake up the SAME tab
 * (it fires for other tabs only), so the writer also dispatches a
 * badge-changed event. subscribeReporterBadge listens to both, which covers
 * multi-tab and same-tab updates alike.
 */
export const REPORTER_BADGE_KEY = "reporterBadgeCode";

export const BADGE_CHANGED_EVENT = "badge-changed";

export function getReporterBadge(): string | null {
  try {
    return localStorage.getItem(REPORTER_BADGE_KEY);
  } catch {
    return null;
  }
}

export function setReporterBadge(code: string): void {
  try {
    localStorage.setItem(REPORTER_BADGE_KEY, code);
    window.dispatchEvent(new Event(BADGE_CHANGED_EVENT));
  } catch {
    // storage unavailable — the badge applies to this session only
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
