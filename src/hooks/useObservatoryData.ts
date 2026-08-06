import { useCallback, useEffect, useRef, useState } from "react";
import { Report, SatelliteHotspot, WilayaStatus, TrappedSOS } from "../types";
import { fetchWithRetry } from "../utils/api";
import { meshClient } from "../lib/mesh";
import { useLiveEvents } from "../utils/live";
import { getDeviceId } from "../utils/device";

export function useObservatoryData() {
  const deviceId = getDeviceId();
  const [reports, setReports] = useState<Report[]>([]);
  const [satellites, setSatellites] = useState<SatelliteHotspot[]>([]);
  const [wilayas, setWilayas] = useState<WilayaStatus[]>([]);
  const [sosCalls, setSosCalls] = useState<TrappedSOS[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [meshStatus, setMeshStatus] = useState<"connecting" | "online" | "offline">("offline");
  const [meshNodeCount, setMeshNodeCount] = useState(0);

  // Parallel data fetching from Express backend
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [reportsRes, satellitesRes, wilayasRes, sosRes, notifsRes] = await Promise.allSettled([
        fetch("/api/reports"),
        fetch("/api/satellite-data"),
        fetch("/api/wilayas"),
        fetch("/api/sos"),
        fetch(`/api/notifications/${deviceId}`),
      ]);

      if (reportsRes.status === "fulfilled" && reportsRes.value.ok) {
        setReports(await reportsRes.value.json());
      }
      if (satellitesRes.status === "fulfilled" && satellitesRes.value.ok) {
        setSatellites(await satellitesRes.value.json());
      }
      if (wilayasRes.status === "fulfilled" && wilayasRes.value.ok) {
        setWilayas(await wilayasRes.value.json());
      }
      if (sosRes.status === "fulfilled" && sosRes.value.ok) {
        setSosCalls(await sosRes.value.json());
      }
      if (notifsRes.status === "fulfilled" && notifsRes.value.ok) {
        setNotifications(await notifsRes.value.json());
      }
      setLastRefreshed(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Failed to fetch fire data:", err);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchData();
    // Poll every 30 seconds for live updates
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
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
        // Multipart upload: avoids sending base64 through the JSON body parser
        const fd = new FormData();
        const imgData = payload.image;
        const mime = imgData.split(";")[0].split(":")[1] || "image/jpeg";
        const base64 = imgData.split(",")[1] || "";
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
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
  }, []);

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
    meshStatus,
    meshNodeCount,
    deviceId,
    fetchData,
    handleCreateReport,
    handleConfirmReport,
    handleMarkNotificationRead,
  };
}