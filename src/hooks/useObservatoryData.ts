import { useCallback, useEffect, useRef, useState } from "react";
import { Report, SatelliteHotspot, WilayaStatus, TrappedSOS, Notification } from "../types";
import { fetchWithRetry } from "../utils/api";
import { meshClient } from "../lib/mesh";
import { broadcastMessage, isMeshSupported } from "../utils/meshBridge";
import { useLiveEvents } from "../utils/live";
import { getDeviceId } from "../utils/device";
import { DATASET_KEYS, DatasetHealth, DatasetKey, FailureReason } from "../utils/datasetHealth";
import {
  validateDataset,
  isValidReport,
  REPORT_STATUSES,
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

const isReportStatus = (v: unknown): boolean =>
  typeof v === "string" && (REPORT_STATUSES as readonly string[]).includes(v);

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
      commit("reports", fetch("/api/reports")),
      commit("satellites", fetch("/api/satellite-data")),
      commit("wilayas", fetch("/api/wilayas")),
      commit("sos", fetch("/api/sos")),
      commit("notifications", fetch(`/api/notifications/${deviceId}`)),
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
      // Superseded by a newer cycle: it owns state, health and the spinner.
      // Report the newest completed outcome so this poll schedules the SAME
      // cadence as the winner instead of a stale fallback.
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
      // "آخر تحديث بيانات" clock only advances on a FULL refresh. A single
      // lucky dataset (e.g. notifications) bumps lastBackendContact instead.
      setLastRefreshed(now);
    } else if (anyOk) {
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
  const lastLiveRefreshRef = useRef(0);
  useLiveEvents((event) => {
    if (["report:new", "report:update", "report:delete", "safezones:changed"].includes(event.type)) {
      const now = Date.now();
      if (now - lastLiveRefreshRef.current > 3000) {
        lastLiveRefreshRef.current = now;
        fetchData();
      }
    }
  });

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
        const report = message.report as unknown;
        // Mesh messages are not cast through, they are verified through: a
        // message that does not satisfy the same report contract the GET poll
        // enforces never reaches state.
        if (!isValidReport(report)) return;
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
    async (payload: any) => {
      let res: Response;

      if (payload.image && typeof payload.image === "string" && payload.image.startsWith("data:image/")) {
        // Multipart upload: avoids sending base64 through the JSON body parser.
        // The data URL is decoded via fetch() into a Blob — the browser-native
        // decoder beats a JS atob() loop on large images (low-bandwidth tool).
        const imgData = payload.image;
        const mime = imgData.split(";")[0].split(":")[1] || "image/jpeg";
        let blob: Blob;
        try {
          blob = await (await fetch(imgData)).blob();
        } catch {
          // Older WebViews may refuse to fetch data URLs: fall back to atob.
          const base64 = imgData.split(",")[1] || "";
          const bin = atob(base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          blob = new Blob([bytes], { type: mime });
        }
        const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
        const fd = new FormData();
        fd.append("image", blob, `report-${Date.now()}.${ext}`);
        for (const [k, v] of Object.entries(payload)) {
          if (k === "image") continue;
          if (v !== undefined && v !== null && v !== "") fd.append(k, String(v));
        }
        fd.append("deviceId", deviceId);
        res = await fetch("/api/reports", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, deviceId }),
        });
      }

      if (!res.ok) {
        let serverMsg: string | undefined;
        try {
          const data = await res.json();
          serverMsg = data?.error;
        } catch {
          // non-JSON error body
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
      if (isValidReport(newReport)) {
        setReports((prev) => {
          const next = [newReport, ...prev];
          reportsRef.current = next;
          return next;
        });
      } else {
        console.warn("Server returned a malformed report payload; keeping the current list");
      }

      // When the local mesh transport is supported (native bridge, PWA peer
      // layer, ...), fan the report out to offline peers: they relay it
      // hop-to-hop until an online device can submit it (meshRelay.ts). The
      // mesh copy never carries PII.
      if (isMeshSupported()) {
        try {
          const { image: _img, deviceId: _did, reporterPhone: _rp, ...meshPayload } = payload;
          const lat = Number(meshPayload.lat) || 0;
          const lng = Number(meshPayload.lng) || 0;
          broadcastMessage(JSON.stringify(meshPayload), "report", lat, lng);
        } catch (err) {
          console.error("Mesh broadcast failed:", err);
        }
      }

      // Refresh stats and statuses
      fetchData();
      return newReport;
    },
    [deviceId, fetchData]
  );

  // Upvote/Confirm fire (Consensus Engine)
  const handleConfirmReport = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/reports/${id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      if (res.ok) {
        const result: any = await res.json();
        const status = result?.status;
        const consensusCount = Number(result?.consensusCount);
        // Same contract as the mesh confirm: only a real status paired with a
        // non-negative integer count is admitted into state.
        if (isReportStatus(status) && Number.isInteger(consensusCount) && consensusCount >= 0) {
          setReports((prev) => {
            const next = prev.map((r) =>
              r.id === id
                ? { ...r, consensusCount, status: status as Report["status"] }
                : r
            );
            reportsRef.current = next;
            return next;
          });
        }
      }
    } catch (err) {
      console.error("Failed to confirm report:", err);
    }
  }, [deviceId]);

  const handleMarkNotificationRead = useCallback(async (id: string) => {
    try {
      await fetchWithRetry(`/api/notifications/${id}/read`, { method: "POST" });
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