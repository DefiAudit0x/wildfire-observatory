import { useState, useEffect, useRef } from "react";
import { Report, SatelliteHotspot, Language } from "../types";
import L from "leaflet";
import { Crown, Users, MapPin, Activity, Eye, Shield, Radio, RefreshCw, Clock, AlertTriangle } from "lucide-react";

const SUPER_ADMIN_PASSWORD = import.meta.env.VITE_SUPER_ADMIN_PASSWORD || "";

interface UserLocationData {
  deviceId: string;
  lat: number;
  lng: number;
  name: string;
  role: string;
  lastSeen: string;
}

interface CentralCommandProps {
  reports: Report[];
  satellites: SatelliteHotspot[];
  userLocation: { lat: number; lng: number } | null;
  lang: Language;
}

export default function CentralCommand({ reports, satellites, userLocation, lang }: CentralCommandProps) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [activeUsers, setActiveUsers] = useState<UserLocationData[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const markersLayer = useRef<L.LayerGroup | null>(null);
  const isArabic = lang === "ar";

  const handleUnlock = () => {
    if (password === SUPER_ADMIN_PASSWORD && SUPER_ADMIN_PASSWORD.length > 0) {
      setUnlocked(true);
      setError("");
    } else {
      setError(isArabic ? "كلمة السر غير صحيحة" : "Mot de passe incorrect");
    }
  };

  // Fetch active user locations
  const fetchUserLocations = async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch(`/api/locations?password=${SUPER_ADMIN_PASSWORD}`);
      if (res.ok) {
        const data = await res.json();
        setActiveUsers(data);
      }
    } catch (err) {
      console.error("Failed to fetch user locations:", err);
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    if (unlocked) {
      fetchUserLocations();
      const interval = setInterval(fetchUserLocations, 15000);
      return () => clearInterval(interval);
    }
  }, [unlocked]);

  // Initialize Leaflet map
  useEffect(() => {
    if (!unlocked || !mapRef.current || mapInstance.current) return;

    const map = L.map(mapRef.current, {
      center: [36.75, 5.0],
      zoom: 8,
      preferCanvas: true,
      zoomControl: false,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OSM",
    }).addTo(map);

    L.control.zoom({ position: "bottomright" }).addTo(map);
    mapInstance.current = map;
    markersLayer.current = L.layerGroup().addTo(map);

    return () => {
      map.remove();
      mapInstance.current = null;
      markersLayer.current = null;
    };
  }, [unlocked]);

  // Update markers when data changes
  useEffect(() => {
    if (!markersLayer.current) return;
    const layer = markersLayer.current;
    layer.clearLayers();

    // Satellite hotspots as circles
    satellites.forEach((sat) => {
      L.circle([sat.lat, sat.lng], {
        radius: Math.max(sat.confidence * 100, 500),
        color: "#f97316",
        fillColor: "#f97316",
        fillOpacity: 0.25,
        weight: 1,
      }).bindPopup(`
        <div class="text-xs font-mono">
          <strong>${isArabic ? "قمر صناعي" : "Satellite"}: ${sat.satellite}</strong><br/>
          ${isArabic ? "ثقة" : "Confiance"}: ${sat.confidence}%<br/>
          ${isArabic ? "وقت المسح" : "Scan"}: ${new Date(sat.scanTime).toLocaleTimeString()}
        </div>
      `).addTo(layer);
    });

    // User locations
    activeUsers.forEach((u) => {
      const color = u.role === "official" ? "#f59e0b" : u.role === "volunteer" ? "#10b981" : "#64748b";
      L.marker([u.lat, u.lng], {
        icon: L.divIcon({
          className: "",
          html: `<div style="
            width:28px;height:28px;border-radius:50%;
            display:flex;align-items:center;justify-content:center;
            font-size:14px;
            background:${color};
            border:2px solid rgba(255,255,255,0.8);
            box-shadow:0 0 15px rgba(0,0,0,0.4);
          ">${u.role === "official" ? "🛡️" : u.role === "volunteer" ? "💚" : "👤"}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
      }).bindPopup(`
        <div class="text-xs font-mono space-y-1">
          <strong>${u.name}</strong><br/>
          ${isArabic ? "الدور" : "Rôle"}: ${u.role === "official" ? (isArabic ? "رسمي" : "Officiel") : u.role === "volunteer" ? (isArabic ? "متطوع" : "Bénévole") : (isArabic ? "مواطن" : "Citoyen")}<br/>
          ${isArabic ? "آخر ظهور" : "Dernière vue"}: ${new Date(u.lastSeen).toLocaleTimeString()}
        </div>
      `).addTo(layer);
    });

    // Reports
    reports.filter(r => r.status !== "rejected").forEach((rep) => {
      const color = rep.severity === "critical" ? "#ef4444" : rep.severity === "high" ? "#f97316" : rep.severity === "medium" ? "#eab308" : "#6ee7b7";
      L.marker([rep.lat, rep.lng], {
        icon: L.divIcon({
          className: "",
          html: `<div style="
            width:24px;height:24px;border-radius:50%;
            display:flex;align-items:center;justify-content:center;
            font-size:12px;
            background:${color};
            border:2px solid rgba(255,255,255,0.8);
            box-shadow:0 0 15px rgba(0,0,0,0.4);
          ">🔥</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
      }).bindPopup(`
        <div class="text-xs font-mono max-w-[200px]">
          <strong>${rep.locationName}</strong><br/>
          ${rep.wilaya}<br/>
          ${isArabic ? "الحالة" : "Statut"}: ${rep.status}<br/>
          ${rep.description.substring(0, 80)}
        </div>
      `).addTo(layer);
    });

    // Fit bounds if we have user locations
    if (activeUsers.length > 0 && mapInstance.current) {
      const group = L.featureGroup(activeUsers.map((u) => L.marker([u.lat, u.lng])));
      mapInstance.current.fitBounds(group.getBounds().pad(0.2));
    }
  }, [activeUsers, satellites, reports, isArabic]);

  if (!unlocked) {
    return (
      <div className="col-span-12 max-w-md mx-auto mt-12">
        <div className="bg-zinc-900/70 border border-amber-500/20 rounded-2xl p-8 shadow-[0_8px_40px_rgba(0,0,0,0.6)] text-center space-y-6">
          <div className="mx-auto w-16 h-16 bg-gradient-to-br from-amber-600 to-yellow-500 rounded-2xl flex items-center justify-center shadow-[0_0_30px_rgba(251,191,36,0.2)]">
            <Crown className="h-8 w-8 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-black text-amber-400">
              {isArabic ? "القيادة المركزية" : "Commandement Central"}
            </h2>
            <p className="text-xs text-gray-400 mt-2">
              {isArabic
                ? "لوحة تحكم شاملة — يُسمح بالدخول فقط للمسؤولين المفوّضين"
                : "Tableau de bord central — Accès réservé aux responsables autorisés"}
            </p>
          </div>
          <div className="space-y-3">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
              placeholder={isArabic ? "كلمة سر القيادة المركزية" : "Mot de passe du Commandement"}
              className="w-full px-4 py-3 bg-black/60 border border-amber-500/30 rounded-xl text-sm text-center text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 transition-all"
              autoFocus
            />
            {error && <p className="text-red-400 text-xs font-bold">{error}</p>}
            <button
              onClick={handleUnlock}
              className="w-full px-6 py-3 bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 text-black font-black rounded-xl text-sm transition-all cursor-pointer flex items-center justify-center gap-2"
            >
              <Eye className="h-4 w-4" />
              {isArabic ? "الدخول إلى القيادة المركزية" : "Accéder au Commandement"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const totalFires = reports.filter(r => r.status !== "resolved").length;
  const criticalFires = reports.filter(r => r.status === "pending" && r.severity === "critical").length;
  const verifiedReports = reports.filter(r => r.status === "verified").length;
  const totalVolunteers = activeUsers.filter(u => u.role === "volunteer").length;
  const totalOfficials = activeUsers.filter(u => u.role === "official").length;
  const satelliteHotspots = satellites.length;

  return (
    <div className="col-span-12 space-y-4">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-950/40 via-zinc-950 to-amber-950/40 border border-amber-500/10 rounded-2xl p-4 md:p-6 shadow-[0_4px_30px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-gradient-to-br from-amber-600 to-yellow-500 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(251,191,36,0.15)]">
              <Crown className="h-6 w-6 text-white" />
            </div>
            <div>
              <h2 className="font-extrabold text-lg text-amber-400 flex items-center gap-2">
                {isArabic ? "القيادة المركزية" : "Commandement Central"}
                <span className="bg-amber-500/10 text-amber-400 text-[9px] px-1.5 py-0.5 rounded-full border border-amber-500/20 font-bold">
                  SUPER ADMIN
                </span>
              </h2>
              <p className="text-[10px] text-gray-500">
                {isArabic ? "رؤية شاملة — كل المستخدمين، كل البلاغات، كل البؤر" : "Vision globale — Tous les utilisateurs, tous les signalements, tous les foyers"}
              </p>
            </div>
          </div>
          <button
            onClick={fetchUserLocations}
            disabled={loadingUsers}
            className="px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-400 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <RefreshCw className={`h-3 w-3 ${loadingUsers ? "animate-spin" : ""}`} />
            {isArabic ? "تحديث" : "Rafraîchir"}
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-3 md:p-4">
          <div className="flex items-center gap-2 text-red-400 mb-1">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
              {isArabic ? "حرائق نشطة" : "Feux actifs"}
            </span>
          </div>
          <p className="text-2xl font-black text-slate-100">{totalFires}</p>
          <p className="text-[10px] text-red-400/80 mt-1">
            {criticalFires > 0 ? `${criticalFires} ${isArabic ? "حرجة" : "critiques"}` : ""}
          </p>
        </div>

        <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-3 md:p-4">
          <div className="flex items-center gap-2 text-emerald-400 mb-1">
            <Shield className="h-4 w-4" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
              {isArabic ? "مؤكدة" : "Vérifiés"}
            </span>
          </div>
          <p className="text-2xl font-black text-slate-100">{verifiedReports}</p>
          <p className="text-[10px] text-emerald-400/80 mt-1">
            {reports.length > 0 ? `${((verifiedReports / reports.length) * 100).toFixed(0)}% ${isArabic ? "من المجموع" : "du total"}` : ""}
          </p>
        </div>

        <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-3 md:p-4">
          <div className="flex items-center gap-2 text-amber-400 mb-1">
            <Radio className="h-4 w-4" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
              {isArabic ? "أقمار صناعية" : "Satellites"}
            </span>
          </div>
          <p className="text-2xl font-black text-slate-100">{satelliteHotspots}</p>
          <p className="text-[10px] text-amber-400/80 mt-1">
            {isArabic ? "بؤرة رصدتها ناسا" : "Hotspots NASA FIRMS"}
          </p>
        </div>

        <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-3 md:p-4">
          <div className="flex items-center gap-2 text-sky-400 mb-1">
            <Users className="h-4 w-4" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
              {isArabic ? "متصل الآن" : "En ligne"}
            </span>
          </div>
          <p className="text-2xl font-black text-slate-100">{activeUsers.length}</p>
          <p className="text-[10px] text-sky-400/80 mt-1">
            {totalVolunteers > 0 ? `${totalVolunteers} ${isArabic ? "متطوع" : "bénévoles"}` : ""}
            {totalVolunteers > 0 && totalOfficials > 0 ? " | " : ""}
            {totalOfficials > 0 ? `${totalOfficials} ${isArabic ? "رسمي" : "officiels"}` : ""}
          </p>
        </div>
      </div>

      {/* Map + Activity Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Full Map */}
        <div className="lg:col-span-8 bg-zinc-900/60 border border-white/5 rounded-xl overflow-hidden shadow-[0_4px_25px_rgba(0,0,0,0.3)]">
          <div className="px-4 py-2.5 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MapPin className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-xs font-bold text-slate-300">
                {isArabic ? "خريطة القيادة — جميع النقاط" : "Carte de commandement — tous les points"}
              </span>
            </div>
            <span className="text-[9px] text-gray-500 flex items-center gap-1">
              <Users className="h-3 w-3" />
              {activeUsers.length} {isArabic ? "مستخدم" : "utilisateurs"}
            </span>
          </div>
          <div ref={mapRef} className="h-[400px] md:h-[500px] w-full" />
        </div>

        {/* Activity Feed */}
        <div className="lg:col-span-4 bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)] flex flex-col">
          <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-xs font-bold text-slate-300">
              {isArabic ? "النشاط الحي" : "Flux d'activité"}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto max-h-[400px] md:max-h-[450px] p-3 space-y-2">
            {reports.slice(0, 30).map((rep) => (
              <div key={rep.id} className="bg-black/40 rounded-lg p-2.5 border border-white/5 text-[11px] space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-200 truncate max-w-[140px]">{rep.locationName}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    rep.status === "pending" ? "bg-yellow-500/10 text-yellow-400" :
                    rep.status === "verified" ? "bg-emerald-500/10 text-emerald-400" :
                    rep.status === "resolved" ? "bg-blue-500/10 text-blue-400" :
                    "bg-red-500/10 text-red-400"
                  }`}>
                    {rep.status}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[9px] text-gray-500">
                  <span>{rep.wilaya}</span>
                  <span>{new Date(rep.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {rep.reporterType === "official" && <span className="text-[8px] text-amber-400">🛡️</span>}
                  {rep.reporterType === "volunteer" && <span className="text-[8px] text-emerald-400">💚</span>}
                  <span className="text-[9px] text-gray-500">
                    {isArabic ? "تأكيد" : "Conf"}: {rep.consensusCount}
                  </span>
                  {rep.aiVerification && (
                    <span className="text-[8px] bg-emerald-950 text-emerald-400 px-1 rounded">AI</span>
                  )}
                </div>
              </div>
            ))}
            {reports.length === 0 && (
              <div className="text-center py-8 text-xs text-gray-600">
                {isArabic ? "لا توجد بلاغات حديثة" : "Aucun signalement récent"}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* User Locations Table */}
      <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)]">
        <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-sky-400" />
          <span className="text-xs font-bold text-slate-300">
            {isArabic ? "المستخدمون النشطون" : "Utilisateurs actifs"}
            <span className="text-gray-500 font-normal ml-1">({activeUsers.length})</span>
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-white/5 text-gray-500">
                <th className="text-left px-4 py-2 font-bold">{isArabic ? "الاسم" : "Nom"}</th>
                <th className="text-left px-4 py-2 font-bold">{isArabic ? "الدور" : "Rôle"}</th>
                <th className="text-left px-4 py-2 font-bold">Lat</th>
                <th className="text-left px-4 py-2 font-bold">Lng</th>
                <th className="text-left px-4 py-2 font-bold">{isArabic ? "آخر ظهور" : "Dernière vue"}</th>
              </tr>
            </thead>
            <tbody>
              {activeUsers.map((u) => (
                <tr key={u.deviceId} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="px-4 py-2 text-slate-200 font-bold">{u.name}</td>
                  <td className="px-4 py-2">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                      u.role === "official" ? "bg-amber-500/10 text-amber-400" :
                      u.role === "volunteer" ? "bg-emerald-500/10 text-emerald-400" :
                      "bg-slate-500/10 text-slate-400"
                    }`}>
                      {u.role === "official" ? (isArabic ? "رسمي" : "Officiel") :
                       u.role === "volunteer" ? (isArabic ? "متطوع" : "Bénévole") :
                       (isArabic ? "مواطن" : "Citoyen")}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-400">{u.lat.toFixed(4)}</td>
                  <td className="px-4 py-2 text-gray-400">{u.lng.toFixed(4)}</td>
                  <td className="px-4 py-2 text-gray-400">{new Date(u.lastSeen).toLocaleTimeString()}</td>
                </tr>
              ))}
              {activeUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-xs text-gray-600">
                    {isArabic ? "لا يوجد مستخدمون نشطون حالياً" : "Aucun utilisateur actif pour le moment"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
