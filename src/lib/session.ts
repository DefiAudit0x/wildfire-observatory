type PollListener = () => void;

const listeners = new Set<PollListener>();
let intervalId: number | null = null;

const POLL_INTERVAL_MS = 60 * 1000;

function tick() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // a failing listener must not break the others
    }
  }
}

/**
 * Single shared interval driving all session/visibility probes, so N hooks
 * never create N timers against the server. Returns an unsubscribe function.
 */
export function subscribeSessionPoll(listener: PollListener): () => void {
  listeners.add(listener);
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