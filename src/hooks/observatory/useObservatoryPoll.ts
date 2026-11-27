import { useCallback, useEffect, useRef, useState } from "react";
import { Report, SatelliteHotspot, WilayaStatus, TrappedSOS, Notification } from "../../types";
import { fetchWithRetry } from "../../utils/api";
import { useLiveEvents } from "../../utils/live";
import { DATASET_KEYS, DatasetHealth, DatasetKey } from "../../utils/datasetHealth";
import { validateDataset } from "../../utils/datasetValidators";
import { adoptServerDeviceId } from "../../utils/device";
import {
  DatasetAttempt,
  EMPTY_DATASET_HEALTH,
  EMPTY_OUTCOME,
  FetchOutcome,
  fetchWithTimeout,
} from "./observatoryShared";

/**
 * THE single owner of the observatory's five dataset states (ARC-H4).
 * Everything that WRITES reports/SOS/etc. does so through this hook's
 * admission functions, so the sync mirrors (reportsRef/sosRef) that decide
 * activity and cadence can never drift from the rendered state.
 */

export interface UseObservatoryPollResult {
  reports: Report[];
  satellites: SatelliteHotspot[];
  satellitesPartial: boolean;
  wilayas: WilayaStatus[];
  sosCalls: TrappedSOS[];
  notifications: Notification[];
  loading: boolean;
  lastRefreshed: number;
  lastBackendContact: number;
  datasetHealth: Record<DatasetKey, DatasetHealth>;
  fetchData: () => Promise<FetchOutcome>;
  admitMeshReport: (report: unknown) => void;
  applyReportConsensus: (id: string, status: unknown, consensusCount: number) => void;
  admitServerReport: (report: unknown) => void;
  /** Legacy surface (returned as setReports): a replace that keeps the sync mirror in lockstep. */
  replaceReports: (next: Report[] | ((prev: Report[]) => Report[])) => void;
  handleMarkNotificationRead: (id: string) => Promise<void>;
}

/**
 * A 403 on the notifications read means the signed cookie is bound to a
 * different device id than the one this browser uses (see
 * server/routes/notifications.ts). The body carries code DEVICE_MISMATCH; a
 * body that cannot be parsed is treated the same — this endpoint refuses
 * with no other 403.
 */
async function isDeviceMismatch(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    return body?.code === "DEVICE_MISMATCH";
  } catch {
    return true;
  }
}

export function useObservatoryPoll(deviceId: string): UseObservatoryPollResult {
  const [reports, setReports] = useState<Report[]>([]);
  const [satellitesPartial, setSatellitesPartial] = useState(false);
  const [satellites, setSatellites] = useState<SatelliteHotspot[]>([]);
  const [wilayas, setWilayas] = useState<WilayaStatus[]>([]);
  const [sosCalls, setSosCalls] = useState<TrappedSOS[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number>(0);
  const [lastBackendContact, setLastBackendContact] = useState<number>(0);
  const [datasetHealth, setDatasetHealth] = useState<Record<DatasetKey, DatasetHealth>>(EMPTY_DATASET_HEALTH);

  // Monotonic fetch-cycle sequence: a cycle superseded by a newer one (poll vs
  // live-event vs post-report refresh) must NOT write state, health or the
  // spinner — otherwise an older response could overwrite a fresher one.
  const cycleRef = useRef(0);
  const cycleAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // Synchronous mirrors of the datasets that decide activity/scheduling, kept
  // in lockstep with every writer so a failed cycle can judge activity from
  // the PRESERVED state (see hasActiveActivity below), not just its own
  // empty fresh lists.
  const reportsRef = useRef<Report[]>([]);
  const sosRef = useRef<TrappedSOS[]>([]);
  const lastOutcomeRef = useRef<FetchOutcome>(EMPTY_OUTCOME);
  // Fix 3c: a single in-flight enrollment shared by every cycle of this hook
  // instance. Two cycles racing to enroll would mint two different server
  // ids (one POST each), and the id the client adopts could end up different
  // from the cookie the browser kept — the last Set-Cookie wins by header
  // arrival order while the adopted id is set by body-read order. Sharing one
  // pending promise makes the adopted id and the cookie come from the same
  // response by construction. The ref is cleared when the promise settles so
  // a later enrollment can proceed.
  const enrollPromiseRef = useRef<Promise<string | null> | null>(null);

  // Enrollment is NOT tied to any cycle signal (see Fix 3b): a newer cycle
  // aborting it is exactly how the response gets lost in the first place.
  const enrollDevice = useCallback(async (): Promise<string | null> => {
    if (!enrollPromiseRef.current) {
      enrollPromiseRef.current = (async () => {
        try {
          const enrollment = await fetchWithTimeout("/api/notifications/enroll", undefined, {
            method: "POST",
          });
          if (!enrollment.ok) return null;
          const assigned = (await enrollment.json().catch(() => null)) as { deviceId?: unknown } | null;
          return typeof assigned?.deviceId === "string" ? assigned.deviceId : null;
        } catch {
          return null;
        } finally {
          enrollPromiseRef.current = null;
        }
      })();
    }
    return enrollPromiseRef.current;
  }, []);

  // Parallel data fetching from Express backend, tracked per dataset. A single
  // endpoint outage never marks the whole backend dead, and a single success
  // never claims the whole observatory is fresh. Dataset commit requires
  // transport + HTTP + JSON + schema validation to pass (datasetValidators);
  // an invalid payload fails THAT dataset only and preserves its previous
  // state — it can never wipe live reports/SOS from the UI.
  const fetchData = useCallback(async (): Promise<FetchOutcome> => {
    cycleAbortRef.current?.abort();
    const cycleController = new AbortController();
    cycleAbortRef.current = cycleController;
    const cycle = ++cycleRef.current;
    if (mountedRef.current) setLoading(true);

    const commit = async (key: DatasetKey, promise: Promise<Response>): Promise<DatasetAttempt> => {
      let res: Response;
      try {
        res = await promise;
      } catch {
        return { ok: false, reason: "transport" };
      }
      if (!res.ok) {
        if (key === "satellites" && res.status === 503) {
          try {
            const body: unknown = await res.json();
            if (body && typeof body === "object" && "hotspots" in body) {
              const validated = validateDataset("satellites", body.hotspots);
              if (cycle === cycleRef.current && mountedRef.current) {
                applyDataset(key, validated);
                setSatellitesPartial(true);
              }
            }
          } catch {
            // Missing, unreadable or invalid partial data preserves the prior dataset.
          }
        }
        return { ok: false, reason: "http" };
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return { ok: false, reason: "parse" };
      }

      try {
        // Schema validation: 200 + JSON is NOT a successful dataset. An
        // invalid payload fails this source only and preserves its prior
        // state — it can never blank reports/SOS from the UI.
        const validated = validateDataset(key, data);
        if (cycle === cycleRef.current && mountedRef.current) {
          applyDataset(key, validated);
          if (key === "satellites") setSatellitesPartial(false);
        }
        return { ok: true, data: validated };
      } catch {
        return { ok: false, reason: "schema" };
      }
    };

    const applyDataset = (key: DatasetKey, validated: unknown[]) => {
      switch (key) {
        case "reports": {
          const list = validated as Report[];
          reportsRef.current = list;
          setReports(list);
          break;
        }
        case "satellites":
          setSatellites(validated as SatelliteHotspot[]);
          break;
        case "wilayas":
          setWilayas(validated as WilayaStatus[]);
          break;
        case "sos": {
          const list = validated as TrappedSOS[];
          sosRef.current = list;
          setSosCalls(list);
          break;
        }
        case "notifications":
          setNotifications(validated as Notification[]);
          break;
      }
    };

    // All five endpoint requests issue in PARALLEL: the poll waits for the
    // slowest response, not the sum of the five. The schema validation lives
    // per-source inside commit and still gates each commit independently.
    // v2.15.0: notifications require an explicit device enrollment — a 401
    // (DEVICE_ENROLLMENT_REQUIRED) enrolls this browser once, then the read
    // retries. Identity is never bound implicitly from a GET URL anymore.
    // Fix 3b: a lost enrollment response also desyncs the client — the server
    // has already bound the cookie to a new id while this browser still uses
    // its old one, so the next read answers 403 DEVICE_MISMATCH. That must
    // re-enroll too (the server returns the bound id), or notifications stay
    // stuck at 403 until cookies are cleared. The enrollment POST is NOT tied
    // to the cycle signal: a newer cycle aborting it is exactly how the
    // response gets lost in the first place.
    // Fix 3c: enrollment is deduplicated per hook instance (enrollDevice) —
    // overlapping cycles share one pending POST instead of minting a second
    // server id that could disagree with the cookie.
    const [reportsOut, satellitesOut, wilayasOut, sosOut, notificationsOut] = await Promise.all([
      commit("reports", fetchWithTimeout("/api/reports", cycleController.signal)),
      commit("satellites", fetchWithTimeout("/api/satellite-data", cycleController.signal)),
      commit("wilayas", fetchWithTimeout("/api/wilayas", cycleController.signal)),
      commit("sos", fetchWithTimeout("/api/sos", cycleController.signal)),
      commit(
        "notifications",
        (async () => {
          const url = `/api/notifications/${deviceId}`;
          let res = await fetchWithTimeout(url, cycleController.signal);
          if (res.status === 401 || (await isDeviceMismatch(res))) {
            const assignedId = await enrollDevice();
            if (assignedId && adoptServerDeviceId(assignedId)) {
              res = await fetchWithTimeout(`/api/notifications/${assignedId}`, cycleController.signal);
            }
          }
          return res;
        })(),
      ),
    ]);

    const outcomes: Record<DatasetKey, DatasetAttempt> = {
      reports: reportsOut,
      satellites: satellitesOut,
      wilayas: wilayasOut,
      sos: sosOut,
      notifications: notificationsOut,
    };

    const anyOk = DATASET_KEYS.some((k) => outcomes[k].ok);
    const allOk = DATASET_KEYS.every((k) => outcomes[k].ok);
    const now = Date.now();

    if (cycle !== cycleRef.current || !mountedRef.current) {
      // Superseded by a newer cycle: IT owns state, health AND the spinner.
      // The spinner follows the CURRENT cycle: the winner clears it when it
      // settles (commit never rejects — a timeout/HTTP failure is a settled
      // outcome), so a hung superseded cycle can never leave loading=true,
      // and a stale cycle can never stop the spinner while the current one
      // is still in flight.
      return lastOutcomeRef.current;
    }

    setDatasetHealth((prev) => {
      const next: Record<DatasetKey, DatasetHealth> = { ...prev };
      for (const key of DATASET_KEYS) {
        next[key] = {
          lastSuccess: outcomes[key].ok ? now : prev[key].lastSuccess,
          lastAttemptOk: outcomes[key].ok,
          lastFailureReason: outcomes[key].ok ? undefined : outcomes[key].reason,
        };
      }
      return next;
    });

    if (allOk) {
      // "Data refreshed" means the whole observatory answered: the UI's
      // "آخر تحديث بيانات" clock only advances on a FULL refresh.
      setLastRefreshed(now);
    }
    if (anyOk) {
      // A full refresh is the strongest backend contact; any single healthy
      // dataset proves reachability. lastBackendContact tracks both.
      setLastBackendContact(now);
    }

    // Activity is judged on the state the observatory NOW holds, not only this
    // poll's fresh payloads: a failed source keeps its previous reports/SOS
    // (state preservation is intentional), so an in-flight fire must keep the
    // poll at its fast cadence even when this poll's GET happened to fail.
    const activityReports =
      reportsOut.ok && reportsOut.data ? (reportsOut.data as Report[]) : reportsRef.current;
    const activitySos = sosOut.ok && sosOut.data ? (sosOut.data as TrappedSOS[]) : sosRef.current;
    const hasActiveActivity =
      activityReports.some((r) => r.status === "pending" || r.status === "verified") ||
      activitySos.some((s) => s.status === "active");

    const outcome: FetchOutcome = { hasActiveActivity, allOk, anyOk };
    lastOutcomeRef.current = outcome;
    if (cycleAbortRef.current === cycleController) cycleAbortRef.current = null;
    if (mountedRef.current) setLoading(false);
    return outcome;
  }, [deviceId, enrollDevice]);

  // Fix 29 (POLL-1): the setup arm restores the mount flag — under
  // StrictMode React runs setup → cleanup → setup, and the old
  // cleanup-only effect left the flag false after the replay, so every
  // later dataset/health/spinner write was discarded while the poll kept
  // fetching. A real unmount still ends false with no re-setup.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cycleAbortRef.current?.abort();
      cycleAbortRef.current = null;
    };
  }, []);

  // Stable self-rescheduling poll: the timer re-arms itself inside its own
  // callback. Cadence is computed from the data THIS poll just returned
  // (fresh payloads, not the pre-poll state), so a new SOS shortens the next
  // wait immediately instead of one cycle later.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const scheduleNext = (delayMs: number) => {
      timer = window.setTimeout(async () => {
        try {
          const outcome = await fetchData();
          if (cancelled) return;
          scheduleNext(outcome.hasActiveActivity ? 10000 : 60000);
        } catch {
          // fetchData is rejection-safe; the guard is for unforeseen failures.
          if (!cancelled) scheduleNext(60000);
        }
      }, delayMs);
    };
    void (async () => {
      const outcome = await fetchData();
      if (cancelled) return;
      scheduleNext(outcome.hasActiveActivity ? 10000 : 60000);
    })();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [fetchData]);

  // Server push events (report created/updated/deleted, safezones changed) → refresh
  const liveRefreshTimerRef = useRef<number | null>(null);
  const liveRefreshInFlightRef = useRef(false);
  const liveRefreshPendingRef = useRef(false);
  const refreshFromLiveEvent = useCallback(async () => {
    if (!mountedRef.current) return;
    if (liveRefreshInFlightRef.current) {
      liveRefreshPendingRef.current = true;
      return;
    }
    liveRefreshInFlightRef.current = true;
    try {
      await fetchData();
    } finally {
      liveRefreshInFlightRef.current = false;
      if (liveRefreshPendingRef.current && mountedRef.current) {
        liveRefreshPendingRef.current = false;
        void refreshFromLiveEvent();
      } else {
        liveRefreshPendingRef.current = false;
      }
    }
  }, [fetchData]);

  useLiveEvents((event) => {
    if (["report:new", "report:update", "report:delete", "safezones:changed"].includes(event.type)) {
      if (liveRefreshTimerRef.current !== null) {
        window.clearTimeout(liveRefreshTimerRef.current);
      }
      // Trailing debounce: refresh once after the burst settles so the final
      // server-side event cannot be skipped by a leading-edge throttle.
      liveRefreshTimerRef.current = window.setTimeout(() => {
        liveRefreshTimerRef.current = null;
        void refreshFromLiveEvent();
      }, 3000);
    }
  });

  useEffect(() => () => {
    liveRefreshPendingRef.current = false;
    // Keep the in-flight marker truthful until the request's finally block.
    // mountedRef/fetchData aborts prevent any post-unmount state writes.
    if (liveRefreshTimerRef.current !== null) {
      window.clearTimeout(liveRefreshTimerRef.current);
      liveRefreshTimerRef.current = null;
    }
  }, []);

  // ---- Admission entry points (used by useMeshSync / useReportSubmission) ----
  // Every writer funnels through these so reportsRef stays in lockstep with
  // the rendered list — the original god-hook did this inline in each block.

  /** Mesh gossip admission (pre-validated by the caller's isValidReport gate). */
  const admitMeshReport = useCallback((report: unknown) => {
    setReports((prev) => {
      if (prev.some((r) => r.id === (report as Report).id)) return prev;
      const next = [report as Report, ...prev];
      reportsRef.current = next;
      return next;
    });
  }, []);

  /** Consensus update from mesh gossip (protocol data validated by the caller). */
  const applyReportConsensus = useCallback((id: string, status: unknown, consensusCount: number) => {
    setReports((prev) => {
      const next = prev.map((r) =>
        r.id === id
          ? { ...r, consensusCount, status: status as Report["status"] }
          : r
      );
      reportsRef.current = next;
      return next;
    });
  }, []);

  /** Server-acknowledged report admission after a successful POST. */
  const admitServerReport = useCallback((report: unknown) => {
    setReports((prev) => {
      if (prev.some((existing) => existing.id === (report as Report).id)) return prev;
      const next = [report as Report, ...prev];
      reportsRef.current = next;
      return next;
    });
  }, []);

  const handleMarkNotificationRead = useCallback(async (id: string) => {
    try {
      const res = await fetchWithRetry(`/api/notifications/${id}/read`, { method: "POST" });
      if (!res.ok) return;
      // Ignore any already-running poll that may contain the unread snapshot.
      cycleRef.current += 1;
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch (e) {
      console.error("Failed to mark notification read", e);
    }
  }, []);

  // Legacy `setReports` surface: same signature as the raw useState setter,
  // but the sync mirror can never drift from the rendered list.
  const replaceReports = useCallback((next: Report[] | ((prev: Report[]) => Report[])) => {
    setReports((prev) => {
      const value = typeof next === "function" ? (next as (p: Report[]) => Report[])(prev) : next;
      reportsRef.current = value;
      return value;
    });
  }, []);

  return {
    reports,
    satellites,
    satellitesPartial,
    wilayas,
    sosCalls,
    notifications,
    loading,
    lastRefreshed,
    lastBackendContact,
    datasetHealth,
    fetchData,
    admitMeshReport,
    applyReportConsensus,
    admitServerReport,
    replaceReports,
    handleMarkNotificationRead,
  };
}
