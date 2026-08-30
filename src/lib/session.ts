type PollListener = () => void;

const listeners = new Set<PollListener>();
let intervalId: number | null = null;
let visibilityHooked = false;

const POLL_INTERVAL_MS = 60 * 1000;

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function tick(force = false) {
  // ARC-L16: the probe exists so VISIBLE UI can reflect session state — a
  // hidden tab gains nothing from a network round-trip every 60s. Skipped
  // ticks are compensated by an immediate probe when the tab returns.
  if (!force && isHidden()) return;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // a failing listener must not break the others
    }
  }
}

function hookVisibilityOnce() {
  if (visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (listeners.size > 0 && !isHidden()) tick(true);
  });
}

/**
 * Single shared interval driving all session/visibility probes, so N hooks
 * never create N timers against the server. Returns an unsubscribe function.
 *
 * ARC-L16: ticks are skipped while the tab is hidden (no UI to reflect state
 * into) and one immediate probe fires when the tab becomes visible again.
 */
export function subscribeSessionPoll(listener: PollListener): () => void {
  listeners.add(listener);
  hookVisibilityOnce();
  if (intervalId === null) {
    tick();
    intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  };
}