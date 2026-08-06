import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { Flame, ShieldAlert, Navigation, Sparkles, BookOpen, Layers, Globe, RefreshCw, AlertCircle, Phone, MessageSquare, Clock, Compass, Shield, Wifi, WifiOff, BadgeCheck, Crown, AlertTriangle, Bell, X, CheckCircle, Info } from "lucide-react";
import { Report, SatelliteHotspot, WilayaStatus, Language, TrappedSOS } from "./types";
import ReportForm from "./components/ReportForm";
import StatisticsPanel from "./components/StatisticsPanel";
import WilayaList from "./components/WilayaList";
import AICopilot from "./components/AICopilot";
import SafetyGuides from "./components/SafetyGuides";
import EvacuationRadar from "./components/EvacuationRadar";
import AdminPanel from "./components/AdminPanel";
import VolunteerRegistration from "./components/VolunteerRegistration";
import SafeEvacuation from "./components/SafeEvacuation";
import TrappedSOSModal from "./components/TrappedSOSModal";
import HomeHub from "./components/HomeHub";
import { fetchWithRetry } from "./utils/api";
import { meshClient } from "./lib/mesh";
import { useLiveEvents } from "./utils/live";

const CentralCommand = lazy(() => import("./components/CentralCommand"));
const InteractiveMap = lazy(() => import("./components/InteractiveMap"));

const PanelFallback = () => (
  <div className="col-span-12 py-24 flex items-center justify-center text-sm text-gray-500 font-bold animate-pulse">
    ⏳ {document.documentElement.lang === "ar" ? "جارٍ تحميل لوحة القيادة..." : "Chargement du tableau de bord..."}
  </div>
);

const getDeviceId = () => {
  let id = sessionStorage.getItem("device_id");
  if (!id) {
    id = `web_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    sessionStorage.setItem("device_id", id);
  }
  return id;
};

export default function App() {
  const [reports, setReports] = useState<Report[]>([]);
  const [satellites, setSatellites] = useState<SatelliteHotspot[]>([]);
  const [wilayas, setWilayas] = useState<WilayaStatus[]>([]);
  const [sosCalls, setSosCalls] = useState<TrappedSOS[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [lang, setLang] = useState<Language>("ar");
  const [meshStatus, setMeshStatus] = useState<"connecting" | "online" | "offline">("offline");
  const [meshNodeCount, setMeshNodeCount] = useState(0);
  const deviceId = getDeviceId();
  
  // Navigation / Interactive states
  const [mapClickedCoords, setMapClickedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"home" | "map" | "report" | "copilot" | "guides" | "radar" | "admin" | "volunteer" | "command" | "evac">("home");
  const [privilegedTabVisible, setPrivilegedTabVisible] = useState(() =>
    !!(sessionStorage.getItem("admin_token") || sessionStorage.getItem("command_token"))
  );

  useEffect(() => {
    const syncPrivileged = () => {
      setPrivilegedTabVisible(
        !!(sessionStorage.getItem("admin_token") || sessionStorage.getItem("command_token"))
      );
    };
    window.addEventListener("storage", syncPrivileged);
    const poll = setInterval(syncPrivileged, 2000);
    return () => {
      window.removeEventListener("storage", syncPrivileged);
      clearInterval(poll);
    };
  }, []);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");

  // Proximity alerts states (recurring proximity checking)
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [activeAlerts, setActiveAlerts] = useState<any[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [showTrappedModal, setShowTrappedModal] = useState(false);

  const isArabic = lang === "ar";

  // Haversine formula to compute exact distance in km between user and fire
  const getProximityDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const R = 6371; // km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  // Obtain user coordinates via live GPS (no simulation)
  useEffect(() => {
    if (navigator.geolocation) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setGeoError(null);
        },
        (err) => {
          console.warn("Geolocation error:", err);
          setGeoError(isArabic ? "تعذّر تحديد موقعك. فعّل GPS للتبليغ الدقيق." : "Localisation GPS indisponible. Activez le GPS pour un signalement précis.");
        },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 }
      );
      return () => navigator.geolocation.clearWatch(watchId);
    } else {
      setGeoError(isArabic ? "المتصفح لا يدعم تحديد الموقع." : "Le navigateur ne supporte pas la géolocalisation.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isArabic]);

  // Heartbeat: send user location to server for Central Command tracking
  useEffect(() => {
    if (!userLocation) return;

    const sendHeartbeat = () => {
      const storedBadge = localStorage.getItem("reporterBadgeCode") || "";
      const storedName = localStorage.getItem("userName") || "مستخدم مباشر";
      const storedRole = localStorage.getItem("userRole") || "citizen";

      fetchWithRetry("/api/location/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          lat: userLocation.lat,
          lng: userLocation.lng,
          name: storedName,
          role: storedRole,
          badgeCode: storedBadge,
        }),
      }).catch(() => {});
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000);
    return () => clearInterval(interval);
  }, [userLocation, deviceId]);

  // Recurrent scanning loop for proximity fires (checks reports list every 15 seconds)
  useEffect(() => {
    if (!userLocation || reports.length === 0) {
      setActiveAlerts([]);
      return;
    }

    const scanProximity = () => {
      const nearReports = reports
        .map((rep) => {
          const dist = getProximityDistance(userLocation.lat, userLocation.lng, rep.lat, rep.lng);
          return { ...rep, distance: dist };
        })
        .filter((rep) => rep.distance <= 30) // Within 30km radius
        .sort((a, b) => a.distance - b.distance);

      setActiveAlerts(nearReports);

      // Web Audio sound alerts
      if (nearReports.length > 0 && !isMuted) {
        try {
          if (!audioCtxRef.current) {
            audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
          }
          const audioCtx = audioCtxRef.current;
          const osc1 = audioCtx.createOscillator();
          const osc2 = audioCtx.createOscillator();
          const gainNode = audioCtx.createGain();

          osc1.type = "sine";
          osc1.frequency.setValueAtTime(880, audioCtx.currentTime);
          
          osc2.type = "sawtooth";
          osc2.frequency.setValueAtTime(440, audioCtx.currentTime);

          gainNode.gain.setValueAtTime(0.04, audioCtx.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.0);

          osc1.connect(gainNode);
          osc2.connect(gainNode);
          gainNode.connect(audioCtx.destination);

          osc1.start();
          osc2.start();
          
          osc1.stop(audioCtx.currentTime + 1.0);
          osc2.stop(audioCtx.currentTime + 1.0);
          setTimeout(() => {
            if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
              audioCtxRef.current.close().catch(() => {});
              audioCtxRef.current = null;
            }
          }, 2000);
        } catch (err) {
          console.warn("Audio feedback blocked or uninitialized in sandbox context.", err);
        }
      }
    };

    scanProximity();
    const alertInterval = setInterval(scanProximity, 15000);
    return () => clearInterval(alertInterval);
  }, [userLocation, reports, isMuted]);

  // Parallel data fetching from Express backend
  const fetchData = async () => {
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
  };

  useEffect(() => {
    fetchData();
    // Poll every 30 seconds for live updates
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

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

  // Operator alert tone when a new critical/high report appears (throttled)
  const lastCriticalIdsRef = useRef<Set<string>>(new Set());
  const lastBeepAtRef = useRef(0);
  useEffect(() => {
    const critical = reports.filter(
      (r) =>
        (r.severity === "critical" || r.severity === "high") &&
        r.status !== "resolved" &&
        r.status !== "rejected"
    );
    const seen = lastCriticalIdsRef.current;
    const newOnes = critical.filter((r) => !seen.has(r.id));
    for (const r of newOnes) seen.add(r.id);
    if (newOnes.length === 0 || isMuted) return;
    const now = Date.now();
    if (now - lastBeepAtRef.current < 20000) return;
    lastBeepAtRef.current = now;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const audioCtx = audioCtxRef.current;
      const t0 = audioCtx.currentTime;
      const hasCritical = newOnes.some((x) => x.severity === "critical");
      for (let i = 0; i < 3; i++) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(hasCritical ? 1200 : 900, t0 + i * 0.35);
        gain.gain.setValueAtTime(0.05, t0 + i * 0.35);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.35 + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0 + i * 0.35);
        osc.stop(t0 + i * 0.35 + 0.3);
      }
      setTimeout(() => {
        if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
          audioCtxRef.current.close().catch(() => {});
          audioCtxRef.current = null;
        }
      }, 2000);
    } catch (err) {
      console.warn("Critical alert tone blocked:", err);
    }
  }, [reports, isMuted]);

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
  const handleCreateReport = async (payload: any) => {
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
  };

  // Save parsed SMS report to database
  // (removed: SMS parsing was part of the simulation-only Crisis Center)

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

  const handleMarkNotificationRead = async (id: string) => {
    try {
      await fetchWithRetry(`/api/notifications/${id}/read`, { method: "POST" });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    } catch (e) {
      console.error("Failed to mark notification read", e);
    }
  };

  const handleMapClick = useCallback((lat: number, lng: number) => {
    setMapClickedCoords({ lat, lng });
    // Switch to report tab on mobile so they can see the form filled immediately
    setActiveTab("report");
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0505] text-slate-100 font-sans flex flex-col selection:bg-red-500 selection:text-white" dir={isArabic ? "rtl" : "ltr"}>
      
      {/* 1. MAIN GLOBAL HEADER */}
      <header className="bg-black/60 backdrop-blur-md border-b border-white/5 sticky top-0 z-[1100] px-4 py-3 md:px-8">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          
          {/* Platform Title */}
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-gradient-to-tr from-red-600 via-orange-600 to-amber-500 rounded-xl flex items-center justify-center shadow-[0_4px_15px_rgba(220,38,38,0.3)] border border-red-500/20">
              <Flame className="h-6 w-6 text-white animate-pulse" />
            </div>
            <div>
              <h1 className="font-extrabold text-lg md:text-xl text-slate-100 tracking-tight leading-none flex items-center gap-2">
                <span>{isArabic ? "المرصد الشمال الإفريقي لحرائق الغابات والكوارث" : "Observatoire Nord-Africain des Feux de Forêt et Catastrophes"}</span>
                <span className="bg-red-600 text-white text-[10px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider animate-pulse">
                  {isArabic ? "مباشر" : "Live"}
                </span>
              </h1>
              <p className="text-[10px] text-gray-400 mt-1">
                {isArabic
                  ? "منصة تضامنية لمتابعة الكوارث والتبليغ الميداني الفوري والتأصيل الجغرافي"
                  : "Plateforme citoyenne de suivi cartographique et de signalement d'urgence"}
              </p>
            </div>
          </div>

          {/* Quick info and Bilingual selector */}
          <div className="flex items-center gap-4 flex-wrap justify-center">
            
            {/* Last refreshed status */}
            <div className="hidden md:flex items-center gap-1.5 text-xs text-gray-400 font-mono">
              <Clock className="h-3.5 w-3.5 text-gray-500" />
              <span>{isArabic ? "آخر تحديث:" : "Tendance :"} {lastRefreshed || "--:--:--"}</span>
              <button
                onClick={fetchData}
                disabled={loading}
                className="p-1 hover:bg-zinc-850 rounded transition-colors cursor-pointer"
                title="Refresh"
              >
                <RefreshCw className={`h-3 w-3 text-gray-400 ${loading ? "animate-spin text-red-500" : ""}`} />
              </button>
            </div>

            {/* Notifications Bell */}
            <div className="relative">
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className="relative p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors cursor-pointer border border-white/5"
                title="Notifications"
              >
                <Bell className="h-4 w-4 text-gray-300" />
                {notifications.some(n => !n.read) && (
                  <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500 animate-pulse border border-black" />
                )}
              </button>
              
              {showNotifications && (
                <div className={`absolute top-full mt-2 w-72 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl z-[1200] overflow-hidden ${isArabic ? "left-0 md:left-auto md:right-0" : "right-0"}`}>
                  <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-zinc-800/50">
                    <h3 className="font-bold text-sm text-slate-100">{isArabic ? "الإشعارات" : "Notifications"}</h3>
                    <button onClick={() => setShowNotifications(false)} className="text-gray-400 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto">
                    {notifications.length === 0 ? (
                      <div className="p-6 text-center text-sm text-gray-400">
                        {isArabic ? "لا توجد إشعارات" : "Aucune notification"}
                      </div>
                    ) : (
                      <div className="flex flex-col">
                        {notifications.map(n => (
                          <div 
                            key={n.id} 
                            onClick={() => !n.read && handleMarkNotificationRead(n.id)}
                            className={`p-4 border-b border-white/5 last:border-0 cursor-pointer transition-colors ${n.read ? "bg-transparent opacity-60" : "bg-white/5 hover:bg-white/10"}`}
                          >
                            <div className="flex items-start gap-3">
                              <div className="shrink-0 mt-0.5">
                                {n.type === "success" && <CheckCircle className="h-4 w-4 text-emerald-500" />}
                                {n.type === "warning" && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                                {n.type === "error" && <AlertCircle className="h-4 w-4 text-red-500" />}
                                {n.type === "info" && <Info className="h-4 w-4 text-blue-500" />}
                              </div>
                              <div className="flex-1">
                                <h4 className={`text-xs font-bold ${!n.read ? "text-slate-100" : "text-gray-400"}`}>
                                  {isArabic ? n.titleAr : n.titleFr}
                                </h4>
                                <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
                                  {isArabic ? n.bodyAr : n.bodyFr}
                                </p>
                                <div className="text-[9px] text-gray-500 mt-2">
                                  {new Date(n.timestamp).toLocaleString(isArabic ? "ar-DZ" : "fr-DZ")}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Mesh network status badge */}
            <button
              onClick={fetchData}
              title={isArabic ? "شبكة المرصد المترابطة (Mesh) — اضغط للتحديث" : "Réseau Mesh de l'observatoire — cliquer pour actualiser"}
              className={`hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold transition-colors cursor-pointer ${
                meshStatus === "online"
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                  : meshStatus === "connecting"
                    ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                    : "bg-zinc-900 border-white/10 text-gray-500"
              }`}
            >
              {meshStatus === "online" ? (
                <Wifi className="h-3.5 w-3.5" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              <span>
                {isArabic ? "شبكة Mesh" : "Réseau Mesh"}
                {meshStatus === "online" && meshNodeCount > 0 ? `: ${meshNodeCount}` : ""}
              </span>
            </button>

            {/* Emergency Hotline summary button */}
            <a
              href="tel:1021"
              className="px-3 py-1.5 bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 hover:border-red-500/40 text-red-400 rounded-lg text-xs font-black flex items-center gap-1.5 transition-all"
            >
              <Phone className="h-3.5 w-3.5 text-red-500 shrink-0" />
              <span>{isArabic ? "الحماية المدنية: 1021" : "Protection Civile : 1021"}</span>
            </a>

            {/* Language Toggle */}
            <button
              onClick={() => setLang(lang === "ar" ? "fr" : "ar")}
              className="px-3 py-1.5 bg-black/40 hover:bg-zinc-900 text-xs text-slate-200 hover:text-white rounded-lg border border-white/5 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Globe className="h-3.5 w-3.5 text-gray-500" />
              <span className="font-bold">{lang === "ar" ? "Français" : "العربية"}</span>
            </button>
          </div>
        </div>
      </header>

      {/* REAL-TIME PROXIMITY DETECTION & NOTIFICATION ALERTS HUD */}
      {activeAlerts.length > 0 && (
        <div className="bg-gradient-to-r from-red-950 via-amber-950/80 to-red-950 border-b border-red-500/30 text-white px-4 py-3 md:px-8 z-[1001]">
          <div className="max-w-7xl mx-auto flex flex-col lg:flex-row items-center justify-between gap-4 font-mono">
            
            {/* Left/Right core threat status */}
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-red-600"></span>
              </span>
              
              <div className="text-xs">
                <p className="font-extrabold text-red-400 flex items-center gap-1">
                  🚨 {isArabic ? "تنبيه اقتراب متكرر: خطر نشط على مقربة منك!" : "ALERTE PROXIMITÉ RECURRENTE : Menace active identifiée !"}
                </p>
                <p className="text-[10.5px] text-slate-200 mt-1 leading-normal">
                  {isArabic 
                    ? `رصد ${activeAlerts.length} بؤرة حريق نشطة على مسافة أقل من 30 كم من إحداثياتك الحالية. البؤرة الأقرب: "${activeAlerts[0].locationName}" على بعد ${activeAlerts[0].distance.toFixed(1)} كم.`
                    : `Détection de ${activeAlerts.length} foyer(s) dans un rayon de 30 km. Foyer le plus proche: "${activeAlerts[0].locationName}" à ${activeAlerts[0].distance.toFixed(1)} km.`
                  }
                </p>
              </div>
            </div>

            {/* Real GPS status and controls */}
            <div className="flex items-center gap-2 flex-wrap text-[10px] font-bold">
              {/* GPS status indicator */}
              <button
                onClick={() => {
                  if (userLocation) {
                    setSelectedReportId(activeAlerts[0].id);
                    setActiveTab("map");
                  }
                }}
                className={`px-2.5 py-1 rounded border transition-all cursor-pointer ${
                  userLocation
                    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                    : "bg-amber-500/20 text-amber-400 border-amber-500/30"
                }`}
                title="Live GPS coordinates"
              >
                {userLocation
                  ? (isArabic ? "🌐 GPS حقيقي: " : "🌐 GPS Réel : ") + `${userLocation.lat.toFixed(3)}, ${userLocation.lng.toFixed(3)}`
                  : (isArabic ? "📍 جاري تحديد الموقع..." : "📍 Localisation GPS...")}
              </button>

              <button
                onClick={() => setIsMuted((prev) => !prev)}
                className="px-2.5 py-1 bg-black/55 hover:bg-black border border-white/10 rounded transition-colors text-slate-300 cursor-pointer"
              >
                {isMuted ? (isArabic ? "🔊 تشغيل الصوت" : "🔊 Activer Son") : (isArabic ? "🔇 كتم صوت الصفارة" : "🔇 Couper Sirène")}
              </button>

              <button
                onClick={() => {
                  setSelectedReportId(activeAlerts[0].id);
                  setActiveTab("map");
                }}
                className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded shadow-md transition-all animate-bounce cursor-pointer"
              >
                🎯 {isArabic ? "تحديد الموقع وإخلاء" : "Localiser & Évacuer"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. RESPONSIVE TAB DECK */}
      <div className="px-4 py-2 flex gap-1.5 bg-black/80 border-b border-white/5 overflow-x-auto sticky top-[65px] z-[1000] justify-start md:justify-center" dir={isArabic ? "rtl" : "ltr"}>
        {[
          { id: "home", labelAr: "بوابة الطوارئ السريعة", labelFr: "Accueil d'Urgence", icon: <ShieldAlert className="h-4 w-4 text-red-500 animate-pulse" /> },
          { id: "map", labelAr: "المرصد والخريطة", labelFr: "Observatoire & Carte", icon: <Layers className="h-4 w-4" /> },
          { id: "radar", labelAr: "رادار الإخلاء والرياح", labelFr: "Radar d'Évacuation", icon: <Compass className="h-4 w-4 text-emerald-400" /> },
          { id: "report", labelAr: "إرسال بلاغ حريق", labelFr: "Signaler un incendie", icon: <AlertCircle className="h-4 w-4 text-red-400" /> },
          { id: "volunteer", labelAr: "تسجيل متطوع", labelFr: "Devenir Volontaire", icon: <BadgeCheck className="h-4 w-4 text-emerald-400" /> },
          { id: "copilot", labelAr: "مساعد الذكاء الاصطناعي", labelFr: "Assistant Gemini IA", icon: <Sparkles className="h-4 w-4 text-purple-400" /> },
          { id: "guides", labelAr: "دليل النجاة والوقاية", labelFr: "Guides de Survie", icon: <BookOpen className="h-4 w-4 text-sky-400" /> },
          { id: "evac", labelAr: "مسارات الإخلاء", labelFr: "Évacuation", icon: <Navigation className="h-4 w-4 text-sky-400" /> },
          ...(privilegedTabVisible
            ? [
                { id: "command", labelAr: "قيادة مركزية", labelFr: "Commandement Central", icon: <Crown className="h-4 w-4 text-amber-400 animate-pulse" /> },
                { id: "admin", labelAr: "لوحة تحكم المشرف", labelFr: "Espace Admin", icon: <Shield className="h-4 w-4 text-emerald-400 animate-pulse" /> },
              ]
            : []),
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center gap-2 px-3.5 py-2.5 rounded-lg text-xs font-black transition-all whitespace-nowrap cursor-pointer ${
              activeTab === tab.id
                ? "bg-red-650 text-white shadow-[0_0_15px_rgba(220,38,38,0.4)] scale-[1.02]"
                : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
            }`}
          >
            {tab.icon}
            <span>{isArabic ? tab.labelAr : tab.labelFr}</span>
          </button>
        ))}
        {!privilegedTabVisible && (
          <button
            onClick={() => setActiveTab("admin")}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-black whitespace-nowrap cursor-pointer text-slate-500 hover:text-slate-300 hover:bg-white/5"
            title={isArabic ? "وصول المشرفين" : "Accès administrateurs"}
          >
            <Shield className="h-4 w-4" />
            <span>{isArabic ? "مشرف" : "Admin"}</span>
          </button>
        )}
      </div>

      {/* 4. MAIN LAYOUT GRID */}
      <main className="flex-1 px-4 py-5 md:px-8 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* Simple Emergency-First Home Screen */}
        {activeTab === "home" && (
          <div className="col-span-12 animate-fadeIn">
            <HomeHub
              onNavigate={(tab) => setActiveTab(tab)}
              onTriggerSOS={() => setShowTrappedModal(true)}
              lang={lang}
              reportsCount={reports.length}
              sosCount={sosCalls.filter(s => s.status === "active").length}
              reports={reports}
              userLocation={userLocation}
              showAdminEntries={privilegedTabVisible}
            />
          </div>
        )}

        {/* Safe Evacuation Radar View */}
        {activeTab === "radar" && (
          <div className="col-span-12">
            <EvacuationRadar reports={reports} userLocation={userLocation} lang={lang} />
          </div>
        )}

        {/* Admin Moderation Panel View */}
        {activeTab === "admin" && (
          <div className="col-span-12">
            <AdminPanel reports={reports} onRefresh={fetchData} lang={lang} />
          </div>
        )}

        {/* Volunteer Registration full page */}
        {activeTab === "volunteer" && (
          <div className="col-span-12 max-w-2xl mx-auto">
            <VolunteerRegistration lang={lang} />
          </div>
        )}

        {/* Central Command - full-screen command dashboard */}
        {activeTab === "command" && (
          <Suspense fallback={<PanelFallback />}>
            <CentralCommand reports={reports} satellites={satellites} sosCalls={sosCalls} userLocation={userLocation} lang={lang} onRefresh={fetchData} />
          </Suspense>
        )}

        {/* Safe Evacuation View */}
        {activeTab === "evac" && (
          <div className="col-span-12 animate-fadeIn">
            <SafeEvacuation lang={lang} userLocation={userLocation} />
          </div>
        )}

        {/* Normal layout columns */}
        {activeTab !== "radar" && activeTab !== "admin" && activeTab !== "volunteer" && activeTab !== "command" && activeTab !== "evac" && activeTab !== "home" && (
          <>
            {/* Live statistics summary cards */}
            {activeTab === "map" && (
              <div className="col-span-12">
                <StatisticsPanel reports={reports} satellites={satellites} lang={lang} />
              </div>
            )}

            {/* LEFT MAIN PANELS (Leaflet Map, Guidance, Guides) - Spans 8 columns on desktop */}
            <section className={`lg:col-span-8 space-y-6 ${activeTab === "map" || activeTab === "guides" ? "block" : "hidden md:block"}`}>
              {/* Map Box */}
              {activeTab === "map" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h2 className="font-bold text-slate-100 flex items-center gap-1.5 text-base">
                      <Navigation className="h-4 w-4 text-red-500 animate-bounce" />
                      <span>
                        {isArabic
                          ? "الخريطة التفاعلية لرصد حرائق الغابات في شمال إفريقيا"
                          : "Carte interactive de surveillance des feux de forêt en Afrique du Nord"}
                      </span>
                    </h2>
                    {mapClickedCoords && (
                      <button
                        onClick={() => setMapClickedCoords(null)}
                        className="text-xs text-red-400 hover:text-red-300 font-bold"
                      >
                        {isArabic ? "إلغاء التثبيت" : "Réinitialiser l'épingle"}
                      </button>
                    )}
                  </div>
                  
                  <Suspense fallback={<PanelFallback />}>
                    <InteractiveMap
                      reports={reports}
                      satellites={satellites}
                      onMapClick={handleMapClick}
                      onConfirmReport={handleConfirmReport}
                      selectedReportId={selectedReportId}
                      lang={lang}
                    />
                  </Suspense>
                </div>
              )}

              {/* Active Community Reports Feed */}
              {activeTab === "map" && (
                <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)]">
                  <h3 className="font-bold text-base text-slate-100 mb-3 flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-orange-500" />
                    <span>{isArabic ? "سجل البلاغات الميدانية الأخيرة" : "Flux des signalements citoyens récents"}</span>
                  </h3>

                  <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                    {reports.length === 0 ? (
                      <div className="text-center py-8 text-xs text-gray-500">
                        {isArabic ? "لا توجد بلاغات مرسلة حالياً في السجل." : "Aucun signalement dans le flux."}
                      </div>
                    ) : (
                      reports.map((rep) => (
                        <div
                          key={rep.id}
                          onClick={() => {
                            setSelectedReportId(rep.id);
                            setActiveTab("map");
                          }}
                          className={`bg-black/40 hover:bg-black/60 p-3.5 rounded-lg border transition-all cursor-pointer flex flex-col md:flex-row gap-3 items-start md:items-center justify-between ${
                            selectedReportId === rep.id ? "border-red-650 bg-red-950/10 shadow-[0_0_15px_rgba(220,38,38,0.15)]" : "border-white/5"
                          }`}
                        >
                          <div className="flex gap-3 items-start">
                            {rep.image && (rep.image.startsWith("data:image/") || rep.image.startsWith("https://")) ? (
                              <img src={rep.image} className="w-16 h-12 object-cover rounded border border-white/5 mt-1" alt="Report image" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="w-16 h-12 bg-black/40 rounded border border-white/5 flex items-center justify-center text-xs text-slate-500">
                                🔥
                              </div>
                            )}
                            <div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <h4 className="font-bold text-xs text-slate-200">{rep.locationName}</h4>
                                {rep.reporterType === "official" && (
                                  <span className="bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[9px] px-1.5 py-0.5 rounded font-black">
                                    🛡️ {isArabic ? "جهة رسمية" : "Officiel"}
                                  </span>
                                )}
                                {rep.reporterType === "volunteer" && (
                                  <span className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[9px] px-1.5 py-0.5 rounded font-bold">
                                    💚 {isArabic ? "متطوع" : "Bénévole"}
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-gray-400 mt-0.5">{rep.wilaya} | {new Date(rep.timestamp).toLocaleTimeString()}</p>
                              <p className="text-[11px] text-gray-300 mt-1 line-clamp-1 italic">{rep.description}</p>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 self-end md:self-auto mt-2 md:mt-0">
                            {rep.clusterSize && rep.clusterSize > 1 && (
                              <span className="bg-orange-500/10 text-orange-400 border border-orange-500/20 text-[9px] px-2 py-0.5 rounded-full font-bold">
                                📍 {isArabic ? `بؤرة مشتركة (${rep.clusterSize})` : `Cluster (${rep.clusterSize})`}
                              </span>
                            )}
                            {rep.aiVerification && (
                              <span className="bg-emerald-950 text-emerald-400 border border-emerald-500/20 text-[9px] px-2 py-0.5 rounded-full font-bold">
                                🤖 {isArabic ? "موثق ذكياً" : "Certifié par IA"}
                              </span>
                            )}
                            <span className="bg-black/50 text-gray-400 border border-white/5 text-[10px] px-2 py-0.5 rounded font-mono font-semibold">
                              {isArabic ? `تأكيد: ${rep.consensusCount}` : `Voisins: ${rep.consensusCount}`}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Guides Section */}
              {activeTab === "guides" && (
                <div>
                  <SafetyGuides lang={lang} />
                </div>
              )}
            </section>

            {/* RIGHT SIDEBAR PANEL */}
            <section className="lg:col-span-4 space-y-6">
              {/* SOS Report Form tab on mobile / Sidebar on desktop */}
              <div className={`${activeTab === "report" ? "block" : "hidden lg:block"}`}>
                <ReportForm
                  mapClickedCoords={mapClickedCoords}
                  onSubmit={handleCreateReport}
                  lang={lang}
                  reports={reports}
                />
              </div>

              {/* Wilayas Statuses List */}
              <div className={`${activeTab === "map" ? "block" : "hidden lg:block"}`}>
                <WilayaList wilayas={wilayas} lang={lang} />
              </div>

              {/* AI Copilot Responder tab on mobile / Sidebar on desktop */}
              <div className={`${activeTab === "copilot" ? "block" : "hidden lg:block"}`}>
                <AICopilot userLocation={mapClickedCoords} lang={lang} />
              </div>

              {/* Printable Emergency Call Card */}
              <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-4 shadow-[0_4px_25px_rgba(0,0,0,0.5)] text-center space-y-3 relative overflow-hidden">
                <div className="absolute top-0 right-0 h-16 w-16 bg-red-500/5 rounded-full blur-xl"></div>
                <h4 className="font-extrabold text-sm text-slate-200">
                  {isArabic ? "📞 أرقام النجدة والإخلاء الوطنية" : "Numéros de Secours Nationaux"}
                </h4>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <a href="tel:1021" className="p-2 bg-black/40 hover:bg-zinc-800 rounded border border-white/5 text-red-400 font-bold flex flex-col items-center">
                    <span className="text-[10px] text-gray-400 font-sans">{isArabic ? "الحماية المدنية" : "Prot. Civile"}</span>
                    <span className="text-sm mt-0.5">1021</span>
                  </a>
                  <a href="tel:1070" className="p-2 bg-black/40 hover:bg-zinc-800 rounded border border-white/5 text-amber-500 font-bold flex flex-col items-center">
                    <span className="text-[10px] text-gray-400 font-sans">{isArabic ? "الرقم الأخضر للغابات" : "Garde forestière"}</span>
                    <span className="text-sm mt-0.5">1070</span>
                  </a>
                </div>
                <p className="text-[9px] text-gray-500 italic">
                  {isArabic ? "اضغط على الأرقام أعلاه للاتصال السريع والمجاني مباشرة." : "Cliquez sur les numéros pour passer un appel direct."}
                </p>
              </div>
            </section>
          </>
        )}

      </main>

      {/* SOS FLOATING ACTION BUTTON */}
      <button
        onClick={() => setShowTrappedModal(true)}
        className="fixed bottom-6 right-6 z-[1500] w-16 h-16 bg-gradient-to-br from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 text-white rounded-full shadow-[0_8px_32px_rgba(220,38,38,0.5)] flex items-center justify-center transition-all duration-300 hover:scale-110 active:scale-95 border border-red-400/30 group"
      >
        <div className="relative flex items-center justify-center">
          <AlertTriangle className="h-7 w-7 animate-pulse group-hover:animate-none" />
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-white rounded-full animate-ping" />
        </div>
        <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[9px] font-black text-red-400 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
          {isArabic ? "أنا محاصر (SOS)" : "Je suis bloqué (SOS)"}
        </span>
      </button>

      {/* Trapped Person SOS Modal */}
      {showTrappedModal && (
        <TrappedSOSModal
          lang={lang}
          onClose={() => {
            setShowTrappedModal(false);
            fetchData();
          }}
          userLocation={userLocation}
        />
      )}

      {/* 5. BRAND FOOTER */}
      <footer className="bg-[#050303]/40 border-t border-white/5 text-center py-6 mt-12 text-xs text-gray-500">
        <div className="max-w-7xl mx-auto px-4 space-y-1.5">
          <p>
            {isArabic
              ? "المرصد الشمال الإفريقي لحرائق الغابات والكوارث - مبادرة تضامنية لتسريع الاستجابة ومشاركة البيانات بين المواطنين."
              : "Observatoire Nord-Africain des Feux de Forêt et Catastrophes - Initiative solidaire de réponse rapide."}
          </p>
          <p className="text-[10px] text-gray-650 font-mono">
            {isArabic
              ? "مدعوم بنموذج الذكاء الاصطناعي وبوابة ناسا للأقمار الصناعية (NASA FIRMS) © 2026."
              : "Propulsé par Gemini AI et la passerelle NASA FIRMS © 2026."}
          </p>
          <p className="text-[11px] text-amber-500/80 font-semibold mt-2">
            {isArabic ? (
              <>
                الحقوق محفوظة لمبرمجي مجموعتنا <span className="font-bold text-amber-400">nova dz</span>. لو أردت الانضمام{" "}
                <a 
                  href="https://facebook.com/groups/1295962545580951/" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="underline hover:text-amber-300 transition-colors font-extrabold"
                >
                  اضغط هنا
                </a>
              </>
            ) : (
              <>
                Tous droits réservés aux développeurs de notre groupe <span className="font-bold text-amber-400">nova dz</span>. Pour nous rejoindre,{" "}
                <a 
                  href="https://facebook.com/groups/1295962545580951/" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="underline hover:text-amber-300 transition-colors font-extrabold"
                >
                  cliquez ici
                </a>
              </>
            )}
          </p>
        </div>
      </footer>
    </div>
  );
}
