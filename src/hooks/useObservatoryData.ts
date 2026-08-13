import { useCallback, useEffect, useRef, useState } from "react";
import { Report, SatelliteHotspot, WilayaStatus, TrappedSOS, Notification } from "../types";
import { fetchWithRetry } from "../utils/api";
import { meshClient } from "../lib/mesh";
import { broadcastMessage, isMeshSupported, checkAndRecordMessageHash } from "../utils/meshBridge";
import { useLiveEvents } from "../utils/live";
import { getDeviceId } from "../utils/device";
import { DATASET_KEYS, DatasetHealth, DatasetKey, FailureReason } from "../utils/datasetHealth";
import {
  validateDataset,
  isValidReport,
  REPORT_STATUSES,
  REPORT_SEVERITIES,
} from "../utils/datasetValidators";

export type { DatasetKey, DatasetHealth };
export { DATASET_KEYS };

/** Result of one dataset attempt: valid payload carried for real data. */
interface DatasetAttempt {
  ok: boolean;
  reason?: FailureReason;
  data?: unknown[];
}

const EMPTY_DATASET_HEALTH: Record<DatasetKey, DatasetHealth> = {
  reports: { lastSuccess: null, lastAttemptOk: false },
  satellites: { lastSuccess: null, lastAttemptOk: false },
  wilayas: { lastSuccess: null, lastAttemptOk: false },
  sos: { lastSuccess: null, lastAttemptOk: false },
  notifications: { lastSuccess: null, lastAttemptOk: false },
};

export interface FetchOutcome {
  /** True when the state the observatory now holds contains pending/verified reports or active SOS. */
  hasActiveActivity: boolean;
  /** Every dataset answered OK in this poll. */
  allOk: boolean;
  /** At least one dataset answered OK in this poll (backend reachable). */
  anyOk: boolean;
}

const EMPTY_OUTCOME: FetchOutcome = { hasActiveActivity: false, allOk: false, anyOk: false };

/**
 * Hard ceiling for every poll request (audit): a raw fetch() with no timeout
 * can stall forever, which would (a) hang the polling loop — scheduleNext
 * never re-arms — and (b) keep the spinner up indefinitely. An aborted
 * request settles as a "transport" failure: a settled outcome, never a hang.
 */
const FETCH_TIMEOUT_MS = 15000;

function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Fields ReportForm sends for a citizen report. The image may be a data URL
 * (multipart path) or absent; coordinates may arrive as strings from the form.
 * severity/reporterType are REAL unions (not loose strings): the compile-time
 * type only helps call sites — the runtime guard in buildLocalPendingReport
 * is what actually protects the schema from values like "nuclear".
 */
export interface CitizenReportPayload {
  lat: number | string;
  lng: number | string;
  locationName: string;
  wilaya: string;
  description: string;
  severity?: Report["severity"];
  reporterName?: string;
  reporterPhone?: string;
  reporterType?: "citizen" | "volunteer" | "official";
  reporterBadgeCode?: string;
  clientGeneratedId?: string;
  image?: string;
}

const isReportStatus = (v: unknown): boolean =>
  typeof v === "string" && (REPORT_STATUSES as readonly string[]).includes(v);

const isReportSeverity = (v: unknown): v is Report["severity"] =>
  typeof v === "string" && (REPORT_SEVERITIES as readonly string[]).includes(v);

/**
 * Mesh fan-out for a report that reached the server: the SERVER's normalized
 * copy is broadcast (the receivers' isValidReport gate admits it), with PII
 * stripped. Coordinates that are not finite points inside physical bounds are
 * NEVER forwarded silently — a silent (0,0) mesh report would poison the map
 * on every peer.
 */
function broadcastReportToMesh(reportLike: { lat?: unknown; lng?: unknown }): void {
  if (!isMeshSupported()) return;
  try {
    const lat = Number(reportLike.lat);
    const lng = Number(reportLike.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      console.warn("Mesh broadcast skipped: invalid coordinates", reportLike.lat, reportLike.lng);
      return;
    }
    // Audit B13: retain deviceId and clientGeneratedId for gateway attribution.
    // PII fields (image, reporterPhone) are still stripped.
    const { image: _img, reporterPhone: _rp, ...meshPayload } = reportLike as Record<string, unknown>;
    broadcastMessage(JSON.stringify(meshPayload), "report", lat, lng);
  } catch (err) {
    console.error("Mesh broadcast failed:", err);
  }
}

/**
 * Mesh fan-out for a report the server REJECTED or was unreachable: the
 * content is broadcast so an online gateway device can submit it to
 * /api/reports (meshRelay). The payload is shaped like a pending report — the
 * same contract receivers' gates enforce — and never carries PII.
 */
function broadcastFailedReportToMesh(payload: CitizenReportPayload): void {
  if (!isMeshSupported()) return;
  try {
    const lat = Number(payload.lat);
    const lng = Number(payload.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      console.warn("Mesh broadcast skipped: invalid coordinates", payload.lat, payload.lng);
      return;
    }
    const pending = buildLocalPendingReport(payload);
    // Audit B13: retain deviceId and clientGeneratedId for gateway attribution.
    const { image: _img, reporterPhone: _rp, ...meshPayload } = pending as unknown as Record<string, unknown>;
    broadcastMessage(JSON.stringify(meshPayload), "report", lat, lng);
  } catch (err) {
    console.error("Mesh broadcast failed:", err);
  }
}

/**
 * Builds the multipart form for an image-bearing report. The data URL is
 * decoded via fetch() into a Blob (the browser-native decoder beats a JS
 * atob() loop on large images), with an atob() fallback for old WebViews.
 * If BOTH decoders fail — a corrupt or non-decodable data URL — the report
 * is still submitted, WITHOUT the image: a broken photo must never block a
 * fire report from reaching the server. The caller receives imageDropped so
 * the reporter is TOLD the photo did not travel (never a silent drop).
 */
async function buildMultipartForm(
  payload: CitizenReportPayload,
  deviceId: string
): Promise<{ fd: FormData; imageDropped: boolean }> {
  const imgData = payload.image as string;
  const mime = imgData.split(";")[0].split(":")[1] || "image/jpeg";
  let blob: Blob | null = null;
  try {
    blob = await (await fetch(imgData)).blob();
  } catch {
    // Older WebViews may refuse to fetch data URLs: fall back to atob.
    try {
      const base64 = imgData.split(",")[1] || "";
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: mime });
    } catch {
      console.warn("Image data URL is not decodable; submitting the report without the image");
    }
  }
  const fd = new FormData();
  if (blob) {
    const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    fd.append("image", blob, `report-${Date.now()}.${ext}`);
  }
  for (const [k, v] of Object.entries(payload)) {
    if (k === "image") continue;
    if (v !== undefined && v !== null && v !== "") fd.append(k, String(v));
  }
  fd.append("deviceId", deviceId);
  return { fd, imageDropped: !blob };
}

/**
 * Display-safe local copy of a report the server accepted but whose response
 * was unreadable. Same fabrication the offline-draft path already uses: the
 * report IS committed server-side, the pending marker just reflects that this
 * device has not yet re-synced it. Coordinates that are not finite points are
 * NaN — never a silent (0,0) that would pin the report to the Gulf of Guinea
 * on the map.
 */
/** Exported for unit tests (pure coercion logic, no hook side effects). */
export function buildLocalPendingReport(payload: CitizenReportPayload): Report {
  const lat = Number(payload.lat);
  const lng = Number(payload.lng);
  return {
    id: payload.clientGeneratedId || `rep-local-${Date.now()}`,
    lat: Number.isFinite(lat) ? lat : NaN,
    lng: Number.isFinite(lng) ? lng : NaN,
    locationName: payload.locationName,
    wilaya: payload.wilaya,
    description: payload.description,
    // Runtime guard (audit): the union type is compile-time only — the payload
    // arrives as DATA, so an out-of-schema severity is coerced to the schema's
    // default, never cast through a type assertion.
    severity: isReportSeverity(payload.severity) ? payload.severity : "medium",
    status: "pending" as const,
    timestamp: new Date().toISOString(),
    consensusCount: 1,
  };
}

export function useObservatoryData() {
  const deviceId = getDeviceId();
  const [reports, setReports] = useState<Report[]>([]);
  const [satellites, setSatellites] = useState<SatelliteHotspot[]>([]);
  const [wilayas, setWilayas] = useState<WilayaStatus[]>([]);
  const [sosCalls, setSosCalls] = useState<TrappedSOS[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number>(0);
  const [lastBackendContact, setLastBackendContact] = useState<number>(0);
  const [meshStatus, setMeshStatus] = useState<"connecting" | "online" | "offline">("offline");
  const [meshNodeCount, setMeshNodeCount] = useState(0);
  const [datasetHealth, setDatasetHealth] = useState<Record<DatasetKey, DatasetHealth>>(EMPTY_DATASET_HEALTH);

  // Monotonic fetch-cycle sequence: a cycle superseded by a newer one (poll vs
  // live-event vs post-report refresh) must NOT write state, health or the
  // spinner — otherwise an older response could overwrite a fresher one.
  const cycleRef = useRef(0);
  // Synchronous mirrors of the datasets that decide activity/scheduling, kept
  // in lockstep with every writer so a failed cycle can judge activity from
  // the PRESERVED state (see hasActiveActivity below), not just its own
  // empty fresh lists.
  const reportsRef = useRef<Report[]>([]);
  const sosRef = useRef<TrappedSOS[]>([]);
  const lastOutcomeRef = useRef<FetchOutcome>(EMPTY_OUTCOME);

  // Parallel data fetching from Express backend, tracked per dataset. A single
  // endpoint outage never marks the whole backend dead, and a single success
  // never claims the whole observatory is fresh. Dataset commit requires
  // transport + HTTP + JSON + schema validation to pass (datasetValidators);
  // an invalid payload fails THAT dataset only and preserves its previous
  // state — it can never wipe live reports/SOS from the UI.
  const fetchData = useCallback(async (): Promise<FetchOutcome> => {
    const cycle = ++cycleRef.current;
    setLoading(true);

    const commit = async (key: DatasetKey, promise: Promise<Response>): Promise<DatasetAttempt> => {
      let res: Response;
      try {
        res = await promise;
      } catch {
        return { ok: false, reason: "transport" };
      }
      if (!res.ok) return { ok: false, reason: "http" };

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
        if (cycle === cycleRef.current) applyDataset(key, validated);
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
    const [reportsOut, satellitesOut, wilayasOut, sosOut, notificationsOut] = await Promise.all([
      commit("reports", fetchWithTimeout("/api/reports")),
      commit("satellites", fetchWithTimeout("/api/satellite-data")),
      commit("wilayas", fetchWithTimeout("/api/wilayas")),
      commit("sos", fetchWithTimeout("/api/sos")),
      commit("notifications", fetchWithTimeout(`/api/notifications/${deviceId}`)),
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

    if (cycle !== cycleRef.current) {
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
    setLoading(false);
    return outcome;
  }, [deviceId]);

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
    if (liveRefreshInFlightRef.current) {
      liveRefreshPendingRef.current = true;
      return;
    }
    liveRefreshInFlightRef.current = true;
    try {
      await fetchData();
    } finally {
      liveRefreshInFlightRef.current = false;
      if (liveRefreshPendingRef.current) {
        liveRefreshPendingRef.current = false;
        void refreshFromLiveEvent();
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
    if (liveRefreshTimerRef.current !== null) {
      window.clearTimeout(liveRefreshTimerRef.current);
      liveRefreshTimerRef.current = null;
    }
  }, []);

  // Mesh network: live peer-to-peer-ish synchronization
  useEffect(() => {
    meshClient.connect();

    const offStatus = meshClient.onStatus((status, count) => {
      setMeshStatus(status);
      setMeshNodeCount(count);
      if (status === "online") {
        window.dispatchEvent(new Event("mesh:online"));
      }
    });

    const offMessage = meshClient.onMessage((message) => {
      if (message.type === "report:new") {
        // Anti-replay: the same gossip must not be admitted twice, even when
        // two transports (WS mesh + refresh poll) deliver it back-to-back.
        // The identity is the report's OWN id when the message carries one
        // (the stable, relay-unchanged key) — never a random UUID that would
        // re-admit the same report on every hop.
        const report = message.report as unknown;
        // Audit B10: validate report BEFORE recording gossip hash to prevent
        // cache poisoning from malformed reports with colliding IDs.
        if (!isValidReport(report)) return;
        const gossipId = JSON.stringify([
          message.type,
          (report as { id?: unknown } | null)?.id ?? message.id,
          message.ts,
          message.lat,
          message.lng,
        ]);
        if (!checkAndRecordMessageHash(gossipId)) return;
        setReports((prev) => {
          if (prev.some((r) => r.id === report.id)) return prev;
          const next = [report, ...prev];
          reportsRef.current = next;
          return next;
        });
      } else if (message.type === "report:confirm") {
        const id = String(message.id);
        const rawStatus = message.status;
        const consensusCount = Number(message.consensusCount);
        // Consensus updates are protocol data: the status must be a real
        // report status and the count a non-negative INTEGER (Infinity,
        // fractions and coerced garbage are not consensus).
        if (
          id &&
          isReportStatus(rawStatus) &&
          Number.isInteger(consensusCount) &&
          consensusCount >= 0
        ) {
          setReports((prev) => {
            const next = prev.map((r) =>
              r.id === id
                ? { ...r, consensusCount, status: rawStatus as Report["status"] }
                : r
            );
            reportsRef.current = next;
            return next;
          });
        }
      }
    });

    return () => {
      offStatus();
      offMessage();
      meshClient.disconnect();
    };
  }, []);

  // Post citizen report handler
  const handleCreateReport = useCallback(
    async (payload: CitizenReportPayload) => {
      let res: Response;
      let imageNotAttached = false;

      try {
        // 15s timeout for all write paths (audit B7): same ceiling as polling.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
          if (payload.image && typeof payload.image === "string" && payload.image.startsWith("data:image/")) {
            // Multipart upload: avoids sending base64 through the JSON body parser.
            const { fd, imageDropped } = await buildMultipartForm(payload, deviceId);
            res = await fetch("/api/reports", { method: "POST", body: fd, signal: controller.signal });
            imageNotAttached = imageDropped;
          } else {
            res = await fetch("/api/reports", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...payload, deviceId }),
              signal: controller.signal,
            });
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        // TRANSPORT failure (server unreachable, request aborted): the report
        // never reached the server, so its content fans out to the mesh for an
        // online gateway device to relay (meshRelay). A server REJECTION (4xx,
        // handled below) is NOT a transport failure — the server read the
        // report and refused it, and relaying it would only re-submit the same
        // refusal; the client keeps the visible error instead.
        console.warn("Report transport failed; fanning out to mesh:", err);
        broadcastFailedReportToMesh(payload);
        throw err;
      }

      if (!res.ok) {
        let serverMsg: string | undefined;
        try {
          const data = await res.json();
          serverMsg = data?.error;
        } catch {
          // non-JSON error body
        }
        if (res.status >= 500) {
          // Server-side failure (5xx): the server is alive but could not
          // commit the report — an online peer may have better luck.
          broadcastFailedReportToMesh(payload);
        }
        const err: any = new Error(serverMsg || "Report failed");
        err.data = { error: serverMsg };
        throw err;
      }

      const newReport = await res.json();

      // The POST response is another state entry point: it must pass the same
      // report contract as the GET poll. A malformed payload is kept out of
      // state — the fetchData refresh right after re-syncs from the validated
      // GET list anyway.
      const reportIsValid = isValidReport(newReport);
      if (reportIsValid) {
        setReports((prev) => {
          if (prev.some((report) => report.id === newReport.id)) return prev;
          const next = [newReport, ...prev];
          reportsRef.current = next;
          return next;
        });
        // On success the SERVER's normalized copy goes onto the mesh (the
        // receivers' isValidReport gate accepts it), never the raw client
        // payload. The mesh copy never carries PII.
        broadcastReportToMesh(newReport);
      } else {
        console.warn("Server returned a malformed report payload; keeping the current list");
      }

      // Refresh stats and statuses
      fetchData();
      // Return contract: the caller (ReportForm) renders this value in the
      // success modal, so the malformed server response must NEVER reach it —
      // a display-safe local copy is built instead (same pattern the offline
      // draft path uses). The imageNotAttached flag rides along so the modal
      // can disclose the dropped photo.
      const displayReport = reportIsValid ? newReport : buildLocalPendingReport(payload);
      return imageNotAttached ? { ...displayReport, imageNotAttached: true } : displayReport;
    },
    [deviceId, fetchData]
  );

  // Upvote/Confirm fire (Consensus Engine)
  const handleConfirmReport = useCallback(async (id: string) => {
    try {
      // 15s timeout for all write paths (audit B7).
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(`/api/reports/${id}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const result: any = await res.json();
        const status = result?.status;
        const consensusCount = Number(result?.consensusCount);
        if (
          isReportStatus(status) &&
          Number.isInteger(consensusCount) &&
          consensusCount >= 0
        ) {
          // The server response is authoritative. Await the read-after-write
          // reconciliation instead of racing an optimistic state update with
          // a GET that may still contain the previous status.
          await fetchData();
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      console.error("Failed to confirm report:", err);
    }
  }, [deviceId, fetchData]);

  const handleMarkNotificationRead = useCallback(async (id: string) => {
    try {
      const res = await fetchWithRetry(`/api/notifications/${id}/read`, { method: "POST" });
      if (!res.ok) return;
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch (e) {
      console.error("Failed to mark notification read", e);
    }
  }, []);

  return {
    reports,
    setReports,
    satellites,
    wilayas,
    sosCalls,
    notifications,
    loading,
    lastRefreshed,
    lastBackendContact,
    datasetHealth,
    meshStatus,
    meshNodeCount,
    deviceId,
    fetchData,
    handleCreateReport,
    handleConfirmReport,
    handleMarkNotificationRead,
  };
}