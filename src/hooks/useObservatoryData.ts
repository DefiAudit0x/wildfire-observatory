import { useCallback, useEffect, useRef, useState } from "react";
import { Report, SatelliteHotspot, WilayaStatus, TrappedSOS, Notification } from "../types";
import { fetchWithRetry } from "../utils/api";
import { meshClient } from "../lib/mesh";
import { broadcastMessage, isMeshSupported } from "../utils/meshBridge";
import { useLiveEvents } from "../utils/live";
import { getDeviceId } from "../utils/device";
import { DATASET_KEYS, DatasetHealth, DatasetKey, FailureReason } from "../utils/datasetHealth";
import { validateDataset } from "../utils/datasetValidators";

export type { DatasetKey, DatasetHealth };
export { DATASET_KEYS };

/** Result of one dataset attempt: valid payload carried for real data. */
interface DatasetAttempt {
  ok: boolean;
  reason: FailureReason;
  data?: unknown[];
}

const EMPTY_DATASET_HEALTH: Record<DatasetKey, DatasetHealth> = {
  reports: { lastSuccess: null, lastAttemptOk: true },
  satellites: { lastSuccess: null, lastAttemptOk: true },
  wilayas: { lastSuccess: null, lastAttemptOk: true },
  sos: { lastSuccess: null, lastAttemptOk: true },
  notifications: { lastSuccess: null, lastAttemptOk: true },
};

export interface FetchOutcome {
  /** True when the data returned by this poll contains pending/verified reports or active SOS. */
  hasActiveActivity: boolean;
  /** Every dataset answered OK in this poll. */
  allOk: boolean;
  /** At least one dataset answered OK in this poll (backend reachable). */
  anyOk: boolean;
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
  const [meshStatus, setMeshStatus] = useState<"connecting" | "online" | "offline">("offline");
  const [meshNodeCount, setMeshNodeCount] = useState(0);
  const [datasetHealth, setDatasetHealth] = useState<Record<DatasetKey, DatasetHealth>>(EMPTY_DATASET_HEALTH);

  // Parallel data fetching from Express backend, tracked per dataset. A single
  // endpoint outage never marks the whole backend dead, and a single success
  // never claims the whole observatory is fresh. Dataset commit requires
  // transport + HTTP + JSON + schema validation to pass (datasetValidators);
  // an invalid payload fails THAT dataset only and preserves its previous
  // state — it can never wipe live reports/SOS from the UI.
  const fetchData = useCallback(async (): Promise<FetchOutcome> => {
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
        return { ok: true, reason: "schema", data: validated };
      } catch {
        return { ok: false, reason: "schema" };
      }
    };

    let freshReports: Report[] = [];
    let freshSos: TrappedSOS[] = [];

    const applyDataset = (key: DatasetKey, validated: unknown[]) => {
      switch (key) {
        case "reports": {
          const list = validated as Report[];
          freshReports = list;
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
          freshSos = list;
          setSosCalls(list);
          break;
        }
        case "notifications":
          setNotifications(validated as Notification[]);
          break;
      }
    };

    const outcomes: Record<DatasetKey, DatasetAttempt> = {
      reports: await commit("reports", fetch("/api/reports")),
      satellites: await commit("satellites", fetch("/api/satellite-data")),
      wilayas: await commit("wilayas", fetch("/api/wilayas")),
      sos: await commit("sos", fetch("/api/sos")),
      notifications: await commit("notifications", fetch(`/api/notifications/${deviceId}`)),
    };

    DATASET_KEYS.forEach((key) => {
      const attempt = outcomes[key];
      if (attempt.ok && attempt.data) applyDataset(key, attempt.data);
    });

    const anyOk = DATASET_KEYS.some((k) => outcomes[k].ok);
    const allOk = DATASET_KEYS.every((k) => outcomes[k].ok);
    const now = Date.now();

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

    if (anyOk) {
      // A poll where at least one dataset succeeded means the backend is
      // reachable — but "all fresh" is derived per-dataset by the UI.
      setLastRefreshed(now);
    }

    const hasActiveActivity =
      freshReports.some((r) => r.status === "pending" || r.status === "verified") ||
      freshSos.some((s) => s.status === "active");

    return { hasActiveActivity, allOk, anyOk };
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
        const report = message.report as Report;
        if (report?.id) {
          setReports((prev) => {
            if (prev.some((r) => r.id === report.id)) return prev;
            return [report, ...prev];
          });
        }
      } else if (message.type === "report:confirm") {
        const id = String(message.id);
        const consensusCount = Number(message.consensusCount);
        const status = String(message.status);
        if (id && !Number.isNaN(consensusCount)) {
          setReports((prev) =>
            prev.map((r) =>
              r.id === id ? { ...r, consensusCount, status: status as Report["status"] } : r
            )
          );
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
      setReports((prev) => [newReport, ...prev]);

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
        const result = await res.json();
        // Update local report consensus & status
        setReports((prev) =>
          prev.map((r) =>
            r.id === id
              ? { ...r, consensusCount: result.consensusCount, status: result.status }
              : r
          )
        );
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