export interface StaffSession {
  authenticated: boolean;
  role: string | null;
  unitId: string | null;
  name: string | null;
  agentId: string | null;
}

const UNAUTHENTICATED_SESSION: StaffSession = {
  authenticated: false,
  role: null,
  unitId: null,
  name: null,
  agentId: null,
};

type PollListener = () => void;
type SessionSubscriber = (session: StaffSession, loading: boolean) => void;

const listeners = new Set<PollListener>();
let intervalId: number | null = null;
let visibilityHooked = false;

const POLL_INTERVAL_MS = 60 * 1000;

// Fix 29 (AUTH-1): the shared module used to share only a clock — every
// useStaffSession() call owned its own session state and its own fetch, so
// App, RosterBoard and StaffManager could disagree with each other until
// the next 60 s tick. The session STATE now lives here too, in one
// module-level store; the hook is a thin subscriber. One fetch per tick,
// every instance reads the same answer.
let sharedSession: StaffSession = { ...UNAUTHENTICATED_SESSION };
let sharedLoading = true;
let sharedFetch: Promise<void> | null = null;
// Fix 29b (CodeRabbit Minor 1): a forced refetch must not reuse a probe
// that started before it. sharedFetchForced records whether the in-flight
// fetch was itself started by a force — a force bypasses a tick probe but
// shares a forced fetch, so two simultaneous refetches still cost one
// request. fetchGeneration is the supersede guard: only the latest started
// fetch may write state, so a stale probe settling late can never
// overwrite the fresh answer.
let sharedFetchForced = false;
let fetchGeneration = 0;
const sessionSubscribers = new Set<SessionSubscriber>();

function notifySessionSubscribers(): void {
  for (const subscriber of [...sessionSubscribers]) {
    try {
      subscriber(sharedSession, sharedLoading);
    } catch {
      // a failing subscriber must not break the others
    }
  }
}

/**
 * Fetches /api/auth/session once and broadcasts the result to every staff
 * session subscriber. Concurrent callers share the in-flight request. It
 * never throws to callers — a failed probe reads as unauthenticated, exactly
 * as the old per-instance refetch did.
 *
 * Fix 29b (CodeRabbit Minor 1): `force` starts a fresh request instead of
 * reusing a probe that may predate the caller — a post-login refetch must
 * not settle with the pre-login probe's 401. A forced fetch shares an
 * already-forced in-flight one (two simultaneous refetches still cost one
 * request), and the generation guard means only the latest started fetch
 * writes state, so the superseded probe's late settle is ignored.
 */
export function fetchSharedSession(force = false): Promise<void> {
  if (sharedFetch && (!force || sharedFetchForced)) return sharedFetch;
  const generation = ++fetchGeneration;
  sharedFetchForced = force;
  sharedFetch = (async () => {
    try {
      const res = await fetch("/api/auth/session", { credentials: "same-origin" });
      // Superseded: a newer fetch owns the answer — write nothing.
      if (generation !== fetchGeneration) return;
      if (res.ok) {
        const data = await res.json();
        sharedSession = {
          authenticated: true,
          role: data.user?.role || null,
          unitId: data.user?.unitId || null,
          name: data.user?.name || null,
          agentId: data.user?.agentId || null,
        };
      } else {
        sharedSession = { ...UNAUTHENTICATED_SESSION };
      }
    } catch {
      if (generation !== fetchGeneration) return;
      sharedSession = { ...UNAUTHENTICATED_SESSION };
    } finally {
      if (generation === fetchGeneration) {
        sharedLoading = false;
        sharedFetch = null;
        sharedFetchForced = false;
        notifySessionSubscribers();
      }
    }
  })();
  return sharedFetch;
}

export function getStaffSessionSnapshot(): StaffSession {
  return sharedSession;
}

export function isStaffSessionLoading(): boolean {
  return sharedLoading;
}

/**
 * Subscribes to the shared staff session. The callback fires immediately
 * with the current snapshot (a late-mounting instance reads the current
 * truth at once, with loading: false if the first probe already settled)
 * and again on every change. When the last subscriber leaves, the cache
 * resets to unauthenticated + loading (fresh-mount semantics, and test
 * isolation — in production App holds one subscription for the app
 * lifetime, so this only ever fires on full unmount).
 */
export function subscribeStaffSession(subscriber: SessionSubscriber): () => void {
  subscriber(sharedSession, sharedLoading);
  sessionSubscribers.add(subscriber);
  // Fix 29b (CodeRabbit Minor 2): the visibility handler must exist for
  // staff-only mounts too — it used to be installed only by
  // subscribeSessionPoll, so a staff-only mount never recovered on tab
  // return. hookVisibilityOnce is idempotent.
  hookVisibilityOnce();
  ensureInterval();
  // Fix 29b (CodeRabbit Minor 3): a first staff subscriber fetches at once.
  // ensureInterval only ticks when it creates the interval, so when the
  // admin probe (App.tsx line 31) already created it before the staff hook
  // (line 32) mounted, the staff session waited up to 60 s with a valid
  // cookie. The old per-instance hook fetched on every mount; the first
  // subscriber restores that. Later subscribers read the snapshot, and a
  // fetch already in flight is shared, not duplicated.
  if (sessionSubscribers.size === 1) void fetchSharedSession();
  return () => {
    sessionSubscribers.delete(subscriber);
    if (sessionSubscribers.size === 0) {
      sharedSession = { ...UNAUTHENTICATED_SESSION };
      sharedLoading = true;
    }
    maybeStopInterval();
  };
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function tick(force = false) {
  // ARC-L16: the probe exists so VISIBLE UI can reflect session state — a
  // hidden tab gains nothing from a network round-trip every 60s. Skipped
  // ticks are compensated by an immediate probe when the tab returns.
  if (!force && isHidden()) return;
  // One shared staff fetch per tick, however many instances are mounted.
  if (sessionSubscribers.size > 0) void fetchSharedSession();
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
    if ((listeners.size > 0 || sessionSubscribers.size > 0) && !isHidden()) tick(true);
  });
}

function ensureInterval(): void {
  if (intervalId === null) {
    tick();
    intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
  }
}

function maybeStopInterval(): void {
  if (listeners.size === 0 && sessionSubscribers.size === 0 && intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
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
  } else {
    // Fix 29b (same class as Minor 3): a listener mounting after the
    // interval exists would otherwise wait up to 60 s for its first probe.
    // The tick on interval creation already calls it on first mount, so
    // this arm only fires for late mounts — no double probe.
    listener();
  }
  return () => {
    listeners.delete(listener);
    maybeStopInterval();
  };
}
