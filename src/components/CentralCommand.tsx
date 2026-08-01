import { useState, useEffect, useRef } from "react";
import { Report, SatelliteHotspot, Language, TrappedSOS } from "../types";
import L from "leaflet";
import { Crown, Users, MapPin, Activity, Eye, Shield, Radio, RefreshCw, AlertTriangle, Phone, Clock, Check, Truck, HeartHandshake } from "lucide-react";

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
  sosCalls?: TrappedSOS[];
  userLocation: { lat: number; lng: number } | null;
  lang: Language;
  onRefresh?: () => void;
}

const PREDEFINED_TEAMS = [
  {
    id: "unit_1",
    type: "protection_civile" as const,
    teamNameAr: "وحدة التدخل السريع - الحماية المدنية 1",
    teamNameFr: "Unité d'Intervention Rapide - Protection Civile 1",
    emoji: "🚒",
    color: "#ef4444",
    baseLat: 36.72,
    baseLng: 4.91,
    offset: { dLat: 0.025, dLng: -0.03 }
  },
  {
    id: "unit_2",
    type: "protection_civile" as const,
    teamNameAr: "وحدة الدعم والإسناد - الحماية المدنية بجاية",
    teamNameFr: "Unité de Soutien - Protection Civile Béjaïa",
    emoji: "🚒",
    color: "#ef4444",
    baseLat: 36.75,
    baseLng: 5.06,
    offset: { dLat: 0.035, dLng: 0.02 }
  },
  {
    id: "unit_3",
    type: "protection_civile" as const,
    teamNameAr: "وحدة الإطفاء والإنقاذ الجبلية",
    teamNameFr: "Unité Mobile de Lutte Contre les Feux de Forêt",
    emoji: "🚒",
    color: "#ef4444",
    baseLat: 36.68,
    baseLng: 5.22,
    offset: { dLat: -0.02, dLng: -0.035 }
  },
  {
    id: "vol_1",
    type: "volunteers" as const,
    teamNameAr: "مجموعة الهلال الأحمر الجزائري - متطوعي الإغاثة",
    teamNameFr: "Groupe Croissant Rouge Algérien - Secouristes",
    emoji: "💚",
    color: "#10b981",
    baseLat: 36.74,
    baseLng: 4.88,
    offset: { dLat: -0.03, dLng: 0.025 }
  },
  {
    id: "vol_2",
    type: "volunteers" as const,
    teamNameAr: "رابطة المتطوعين والشباب المحلي للإغاثة",
    teamNameFr: "Association des Jeunes Volontaires Locaux",
    emoji: "💚",
    color: "#10b981",
    baseLat: 36.71,
    baseLng: 5.15,
    offset: { dLat: 0.015, dLng: -0.035 }
  },
  {
    id: "vol_3",
    type: "volunteers" as const,
    teamNameAr: "فرقة الدراجات النارية الجبلية للمتطوعين",
    teamNameFr: "Brigade Moto Tout-Terrain des Volontaires",
    emoji: "💚",
    color: "#10b981",
    baseLat: 36.62,
    baseLng: 5.01,
    offset: { dLat: -0.025, dLng: 0.03 }
  }
];

export default function CentralCommand({ reports, satellites, sosCalls = [], userLocation, lang, onRefresh }: CentralCommandProps) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [enteredPassword, setEnteredPassword] = useState("");
  const [error, setError] = useState("");
  const [activeUsers, setActiveUsers] = useState<UserLocationData[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [validating, setValidating] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const markersLayer = useRef<L.LayerGroup | null>(null);
  const isArabic = lang === "ar";

  const [dispatchingSosId, setDispatchingSosId] = useState<string | null>(null);
  const [dispatchType, setDispatchType] = useState<'protection_civile' | 'volunteers'>('protection_civile');
  const [selectedTeam, setSelectedTeam] = useState('');
  const [dispatchNotes, setDispatchNotes] = useState('');
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [ticker, setTicker] = useState(0);

  // States for the table dispatch functionality
  const [tableDispatchSosId, setTableDispatchSosId] = useState<Record<string, string>>({});
  const [tableDispatchNotes, setTableDispatchNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = setInterval(() => {
      setTicker(t => t + 1);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  const getTeamStatusText = (dispatchedAt: string) => {
    const elapsed = Date.now() - new Date(dispatchedAt).getTime();
    const duration = 2 * 60000; // 2 minutes
    if (elapsed >= duration) {
      return {
        text: isArabic ? "✓ وصلت للموقع" : "✓ Arrivée",
        arrived: true
      };
    }
    const remainingMin = Math.ceil((duration - elapsed) / 60000);
    return {
      text: isArabic ? `في الطريق (${remainingMin} د)` : `En route (~${remainingMin} min)`,
      arrived: false
    };
  };

  const getTeamsStatusAndPositions = () => {
    return PREDEFINED_TEAMS.map((team) => {
      let activeSosAssisted: TrappedSOS | null = null;
      let dispatchInfo: any = null;

      for (const sos of sosCalls) {
        if (sos.status !== "active") continue;
        if (sos.dispatchedTeams && sos.dispatchedTeams.length > 0) {
          const found = sos.dispatchedTeams.find(
            (t) => t.teamNameFr === team.teamNameFr || t.teamNameAr === team.teamNameAr
          );
          if (found) {
            activeSosAssisted = sos;
            dispatchInfo = found;
            break;
          }
        }
      }

      if (activeSosAssisted && dispatchInfo) {
        let dispatchedTime = Date.now();
        if (dispatchInfo.dispatchedAt) {
          if (typeof dispatchInfo.dispatchedAt === "string") {
            dispatchedTime = new Date(dispatchInfo.dispatchedAt).getTime();
          } else if (typeof dispatchInfo.dispatchedAt === "object" && (dispatchInfo.dispatchedAt as any).seconds) {
            dispatchedTime = (dispatchInfo.dispatchedAt as any).seconds * 1000;
          } else {
            dispatchedTime = new Date(dispatchInfo.dispatchedAt).getTime();
          }
        }
        if (isNaN(dispatchedTime)) {
          dispatchedTime = Date.now();
        }

        const elapsed = Date.now() - dispatchedTime;
        const duration = 2 * 60000; // 2 minutes journey
        let progress = elapsed / duration;
        if (isNaN(progress)) progress = 0;
        progress = Math.min(1, Math.max(0, progress));

        const startLat = activeSosAssisted.lat + team.offset.dLat;
        const startLng = activeSosAssisted.lng + team.offset.dLng;

        const currentLat = startLat + (activeSosAssisted.lat - startLat) * progress;
        const currentLng = startLng + (activeSosAssisted.lng - startLng) * progress;

        const arrived = progress >= 1;
        const remainingMin = Math.ceil((duration - elapsed) / 60000);

        return {
          ...team,
          status: (arrived ? "on_site" : "en_route") as "available" | "en_route" | "on_site",
          currentLat,
          currentLng,
          arrived,
          remainingMin,
          assistedPerson: activeSosAssisted.name,
          notes: dispatchInfo.notes
        };
      }

      return {
        ...team,
        status: "available" as const,
        currentLat: team.baseLat,
        currentLng: team.baseLng,
        arrived: false,
        remainingMin: 0,
        assistedPerson: null,
        notes: ""
      };
    });
  };

  const handleTargetTeam = (lat: number, lng: number, name: string, emoji: string, statusText: string) => {
    if (mapInstance.current) {
      mapInstance.current.setView([lat, lng], 13);
      L.popup()
        .setLatLng([lat, lng])
        .setContent(`
          <div class="text-xs font-mono p-1 text-slate-100" dir="${isArabic ? "rtl" : "ltr"}">
            <strong class="text-amber-400">${emoji} ${name}</strong><br/>
            <span class="text-slate-300">${statusText}</span><br/>
            <span class="text-gray-500 text-[10px]">GPS: ${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
          </div>
        `)
        .openOn(mapInstance.current);
    }
  };

  const handleDirectDispatch = async (teamId: string, sosId: string, notes: string) => {
    if (!sosId) return;
    setDispatchLoading(true);

    const team = PREDEFINED_TEAMS.find(t => t.id === teamId);
    if (!team) {
      setDispatchLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/sos/${sosId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: team.type,
          teamNameAr: team.teamNameAr,
          teamNameFr: team.teamNameFr,
          notes: notes || ""
        })
      });

      if (res.ok) {
        setTableDispatchSosId(prev => ({ ...prev, [teamId]: "" }));
        setTableDispatchNotes(prev => ({ ...prev, [teamId]: "" }));
        if (onRefresh) onRefresh();
      }
    } catch (err) {
      console.error("Direct dispatch failed:", err);
    } finally {
      setDispatchLoading(false);
    }
  };

  const handleDispatchSubmit = async (sosId: string) => {
    if (!selectedTeam) return;
    setDispatchLoading(true);

    let teamNameAr = "";
    let teamNameFr = "";

    if (dispatchType === 'protection_civile') {
      if (selectedTeam === 'unit_1') {
        teamNameAr = "وحدة التدخل السريع - الحماية المدنية 1";
        teamNameFr = "Unité d'Intervention Rapide - Protection Civile 1";
      } else if (selectedTeam === 'unit_2') {
        teamNameAr = "وحدة الدعم والإسناد - الحماية المدنية بجاية";
        teamNameFr = "Unité de Soutien - Protection Civile Béjaïa";
      } else if (selectedTeam === 'unit_3') {
        teamNameAr = "وحدة الإطفاء والإنقاذ الجبلية";
        teamNameFr = "Unité Mobile de Lutte Contre les Feux de Forêt";
      } else {
        teamNameAr = selectedTeam;
        teamNameFr = selectedTeam;
      }
    } else {
      if (selectedTeam === 'vol_1') {
        teamNameAr = "مجموعة الهلال الأحمر الجزائري - متطوعي الإغاثة";
        teamNameFr = "Groupe Croissant Rouge Algérien - Secouristes";
      } else if (selectedTeam === 'vol_2') {
        teamNameAr = "رابطة المتطوعين والشباب المحلي للإغاثة";
        teamNameFr = "Association des Jeunes Volontaires Locaux";
      } else if (selectedTeam === 'vol_3') {
        teamNameAr = "فرقة الدراجات النارية الجبلية للمتطوعين";
        teamNameFr = "Brigade Moto Tout-Terrain des Volontaires";
      } else {
        teamNameAr = selectedTeam;
        teamNameFr = selectedTeam;
      }
    }

    try {
      const res = await fetch(`/api/sos/${sosId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: dispatchType,
          teamNameAr,
          teamNameFr,
          notes: dispatchNotes
        })
      });

      if (res.ok) {
        setDispatchingSosId(null);
        setSelectedTeam('');
        setDispatchNotes('');
        if (onRefresh) onRefresh();
      }
    } catch (err) {
      console.error("Dispatch request failed:", err);
    } finally {
      setDispatchLoading(false);
    }
  };

  const handleUnlock = async () => {
    setValidating(true);
    setError("");
    try {
      const res = await fetch("/api/auth/central-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.valid) {
        setEnteredPassword(password);
        setUnlocked(true);
      } else {
        setError(isArabic ? "كلمة السر غير صحيحة" : "Mot de passe incorrect");
      }
    } catch {
      setError(isArabic ? "فشل الاتصال بالخادم" : "Erreur de connexion au serveur");
    } finally {
      setValidating(false);
    }
  };

  // Fetch active user locations
  const fetchUserLocations = async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch(`/api/locations?password=${encodeURIComponent(enteredPassword)}`);
      if (res.ok) {
        const data = await res.json();
        setActiveUsers(data);
      }
      if (onRefresh) {
        onRefresh();
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
  }, [unlocked, enteredPassword]);

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

    map.invalidateSize();
    const t1 = setTimeout(() => map.invalidateSize(), 200);

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    if (mapRef.current) {
      resizeObserver.observe(mapRef.current);
    }

    return () => {
      clearTimeout(t1);
      resizeObserver.disconnect();
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

    // Active SOS Calls
    sosCalls.filter(s => s.status === "active").forEach((sos) => {
      L.marker([sos.lat, sos.lng], {
        icon: L.divIcon({
          className: "",
          html: `<div style="
            width:32px;height:32px;border-radius:50%;
            display:flex;align-items:center;justify-content:center;
            font-size:16px;
            background:#dc2626;
            border:3px solid #ffffff;
            box-shadow:0 0 20px #ef4444;
          " class="animate-pulse">🚨</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        }),
      }).bindPopup(`
        <div class="text-xs font-mono max-w-[200px] space-y-1">
          <strong style="color:#ef4444; font-weight:900;">⚠️ ${isArabic ? "استغاثة نشطة" : "SOS ACTIVE"}</strong><br/>
          <strong>${sos.name}</strong><br/>
          ${isArabic ? "الهاتف" : "Tél"}: ${sos.phone || (isArabic ? "غير متوفر" : "Non fourni")}<br/>
          ${isArabic ? "الوقت" : "Temps"}: ${new Date(sos.timestamp).toLocaleTimeString()}<br/>
          <div class="pt-2">
            <a href="https://www.google.com/maps/search/?api=1&query=${sos.lat},${sos.lng}" target="_blank" style="background:#dc2626; color:#ffffff; font-weight:bold; padding:4px 8px; border-radius:4px; display:block; text-align:center; text-decoration:none;">
              ${isArabic ? "فتح في خرائط جوجل" : "Ouvrir dans Google Maps"}
            </a>
          </div>
        </div>
      `).addTo(layer);
    });

    // Active Teams (Civil Protection & Volunteers)
    const teams = getTeamsStatusAndPositions();
    teams.forEach((t) => {
      let teamStatusLabel = "";
      if (t.status === "available") {
        teamStatusLabel = isArabic ? "متاح في المقر" : "Disponible à la base";
      } else if (t.status === "en_route") {
        teamStatusLabel = isArabic ? `في الطريق لنجدة ${t.assistedPerson} (الوصول بعد ~${t.remainingMin} د)` : `En route assiste ${t.assistedPerson} (ETA: ~${t.remainingMin} min)`;
      } else {
        teamStatusLabel = isArabic ? `وصل للموقع لـ ${t.assistedPerson}` : `Arrivé sur site chez ${t.assistedPerson}`;
      }

      L.marker([t.currentLat, t.currentLng], {
        icon: L.divIcon({
          className: "",
          html: `
            <div class="relative flex items-center justify-center" style="width: 32px; height: 32px;">
              <div class="absolute inset-0 rounded-full ${t.status === 'en_route' ? 'animate-ping' : ''} opacity-25" style="background-color: ${t.color};"></div>
              <div class="relative z-10 h-8 w-8 rounded-full flex items-center justify-center shadow-lg border-2 bg-zinc-900" style="border-color: ${t.color}; border-style: solid;">
                <span class="text-sm">${t.emoji}</span>
              </div>
              <div class="absolute -top-1 -right-1 w-3 h-3 rounded-full border border-zinc-950 ${t.status === 'available' ? 'bg-emerald-500' : t.status === 'en_route' ? 'bg-amber-500 animate-pulse' : 'bg-red-500 animate-pulse'}"></div>
            </div>
          `,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        }),
      }).bindPopup(`
        <div class="text-xs font-mono p-1 space-y-1" dir="${isArabic ? "rtl" : "ltr"}">
          <div class="flex items-center gap-1.5 font-bold text-slate-100 bg-slate-800 p-1.5 rounded border border-slate-700">
            <span>${t.emoji}</span>
            <span style="color: ${t.color};">${t.type === 'protection_civile' ? (isArabic ? 'الحماية المدنية' : 'Protection Civile') : (isArabic ? 'المتطوعين' : 'Volontaires')}</span>
          </div>
          <div class="text-slate-300 space-y-1">
            <p><strong>${isArabic ? "الفرقة:" : "Équipe:"}</strong> ${isArabic ? t.teamNameAr : t.teamNameFr}</p>
            <p><strong>${isArabic ? "الحالة:" : "Statut:"}</strong> ${teamStatusLabel}</p>
            ${t.assistedPerson ? `<p><strong>${isArabic ? "المستغيث:" : "Assiste:"}</strong> ${t.assistedPerson}</p>` : ""}
            ${t.notes ? `<p><strong>${isArabic ? "ملاحظات:" : "Notes:"}</strong> ${t.notes}</p>` : ""}
            <p><strong>${isArabic ? "الإحداثيات:" : "GPS:"}</strong> ${t.currentLat.toFixed(4)}, ${t.currentLng.toFixed(4)}</p>
          </div>
        </div>
      `).addTo(layer);
    });

    // Fit bounds if we have user locations
    if (activeUsers.length > 0 && mapInstance.current) {
      const group = L.featureGroup(activeUsers.map((u) => L.marker([u.lat, u.lng])));
      mapInstance.current.fitBounds(group.getBounds().pad(0.2));
    }
  }, [activeUsers, satellites, reports, sosCalls, isArabic, ticker]);

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
              placeholder={isArabic ? "كلمة السر (" + "super" + "admin" + "123)" : "Mot de passe (" + "super" + "admin" + "123)"}
              className="w-full px-4 py-3 bg-black/60 border border-amber-500/30 rounded-xl text-sm text-center text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 transition-all"
              autoFocus
            />
            {error && <p className="text-red-400 text-xs font-bold">{error}</p>}
            <button
              onClick={handleUnlock}
              disabled={validating}
              className="w-full px-6 py-3 bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 disabled:opacity-50 text-black font-black rounded-xl text-sm transition-all cursor-pointer flex items-center justify-center gap-2"
            >
              <Eye className="h-4 w-4" />
              {validating
                ? (isArabic ? "جارٍ التحقق..." : "Vérification...")
                : (isArabic ? "الدخول إلى القيادة المركزية" : "Accéder au Commandement")
              }
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {/* SOS Alerts Card */}
        <div className={`border rounded-xl p-3 md:p-4 transition-all duration-300 ${
          sosCalls.filter(s => s.status === "active").length > 0
            ? "bg-red-950/40 border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.25)] animate-pulse col-span-2 md:col-span-1"
            : "bg-zinc-900/60 border-white/5 col-span-2 md:col-span-1"
        }`}>
          <div className="flex items-center gap-2 text-red-500 mb-1">
            <Radio className={`h-4 w-4 ${sosCalls.filter(s => s.status === "active").length > 0 ? "text-red-500 animate-spin font-black" : "text-gray-500"}`} />
            <span className="text-[10px] font-extrabold uppercase tracking-wider text-red-400">
              {isArabic ? "استغاثات SOS" : "SOS Actifs"}
            </span>
          </div>
          <p className={`text-2xl font-black ${sosCalls.filter(s => s.status === "active").length > 0 ? "text-red-500 font-extrabold" : "text-slate-100"}`}>
            {sosCalls.filter(s => s.status === "active").length}
          </p>
          <p className="text-[10px] text-gray-500 mt-1">
            {isArabic ? "نداءات محاصرين جارية" : "Appels citoyens piégés"}
          </p>
        </div>

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

        {/* Dual-Panel Sidebar: Active SOS alerts + Activity Feed */}
        <div className="lg:col-span-4 flex flex-col gap-4">
          {/* Active SOS Panel */}
          <div className="bg-zinc-900/60 border border-red-500/10 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)] flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 bg-red-950/20 border-b border-red-500/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio className="h-3.5 w-3.5 text-red-500 animate-pulse" />
                <span className="text-xs font-black text-red-400">
                  {isArabic ? "استغاثات SOS النشطة" : "Urgences SOS Actives"}
                </span>
              </div>
              <span className="bg-red-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full animate-pulse">
                {sosCalls.filter(s => s.status === "active").length}
              </span>
            </div>
            
            <div className="p-3 space-y-2 overflow-y-auto max-h-[220px]">
              {sosCalls.filter(s => s.status === "active").length === 0 ? (
                <div className="text-center py-6 text-xs text-gray-500 font-bold">
                  🎉 {isArabic ? "لا توجد استغاثات نشطة حالياً" : "Aucun SOS actif"}
                </div>
              ) : (
                sosCalls.filter(s => s.status === "active").map((sos) => (
                  <div key={sos.id} className="bg-red-950/10 border border-red-500/20 rounded-lg p-2.5 text-[11px] space-y-2 text-start relative overflow-hidden">
                    <div className="flex items-center justify-between">
                      <span className="font-black text-slate-100 flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-red-500 animate-ping inline-block" />
                        <span>{sos.name}</span>
                      </span>
                      <span className="text-[9px] text-red-400/80 font-mono">
                        {new Date(sos.timestamp).toLocaleTimeString()}
                      </span>
                    </div>

                    {sos.phone && (
                      <div className="flex items-center gap-1 text-[10px] text-gray-400">
                        <Phone className="h-3 w-3 text-red-400" />
                        <a href={`tel:${sos.phone}`} className="font-bold font-mono hover:underline text-slate-200">
                          {sos.phone}
                        </a>
                      </div>
                    )}

                    {/* SOS Audio Recording Player */}
                    {sos.audioUrl ? (
                      <div className="bg-red-950/60 border border-red-500/30 rounded-lg p-2 space-y-1">
                        <div className="flex items-center justify-between text-[9px] font-bold text-red-300">
                          <span>{isArabic ? "🔊 الاستغاثة الصوتية المسجلة" : "🔊 Message vocal SOS"}</span>
                          {sos.audioDuration && (
                            <span className="font-mono text-gray-400">{sos.audioDuration}s</span>
                          )}
                        </div>
                        <audio controls src={sos.audioUrl} className="w-full h-8 rounded" />
                      </div>
                    ) : (
                      <div className="text-[9px] text-gray-500 italic">
                        {isArabic ? "بدون تسجيل صوتي" : "Pas de vocal"}
                      </div>
                    )}

                    {/* Dispatched Teams List */}
                    {sos.dispatchedTeams && sos.dispatchedTeams.length > 0 && (
                      <div className="space-y-1 text-start pt-1 border-t border-white/5">
                        <span className="text-[9px] font-extrabold uppercase text-amber-400 block">
                          {isArabic ? "الفرق الموجهة:" : "Dépêchés:"}
                        </span>
                        {sos.dispatchedTeams.map((team, idx) => {
                          const status = getTeamStatusText(team.dispatchedAt);
                          return (
                            <div key={idx} className="bg-black/30 border border-white/5 rounded p-1 text-[10px] flex items-center justify-between gap-1">
                              <span className="font-bold text-slate-300 truncate max-w-[130px]">
                                {team.type === "protection_civile" ? "🚒 " : "💚 "}
                                {isArabic ? team.teamNameAr : team.teamNameFr}
                              </span>
                              <span className={`text-[8px] font-extrabold border px-1 py-0.5 rounded shrink-0 ${
                                status.arrived 
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                                  : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                              }`}>
                                {status.text}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Dispatch trigger & form */}
                    <div className="pt-1 border-t border-white/5">
                      {dispatchingSosId === sos.id ? (
                        <div className="bg-black/40 border border-red-500/10 rounded p-1.5 space-y-1.5 text-start mt-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-bold text-red-400">{isArabic ? "توجيه سريع" : "Dispatch"}</span>
                            <button
                              type="button"
                              onClick={() => setDispatchingSosId(null)}
                              className="text-gray-500 hover:text-slate-300 text-[9px] cursor-pointer"
                            >
                              {isArabic ? "إلغاء" : "Annuler"}
                            </button>
                          </div>
                          
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => { setDispatchType('protection_civile'); setSelectedTeam(''); }}
                              className={`flex-1 py-0.5 px-1 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                                dispatchType === 'protection_civile' ? "bg-red-500/10 border-red-500/30 text-red-400" : "bg-black/20 border-white/5 text-gray-500"
                              }`}
                            >
                              🚒 {isArabic ? "حماية" : "PC"}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setDispatchType('volunteers'); setSelectedTeam(''); }}
                              className={`flex-1 py-0.5 px-1 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                                dispatchType === 'volunteers' ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-black/20 border-white/5 text-gray-500"
                              }`}
                            >
                              💚 {isArabic ? "متطوع" : "VOL"}
                            </button>
                          </div>

                          <select
                            value={selectedTeam}
                            onChange={(e) => setSelectedTeam(e.target.value)}
                            className="w-full bg-zinc-950 border border-white/10 rounded p-1 text-[10px] text-slate-300 focus:outline-none"
                          >
                            <option value="">{isArabic ? "اختر فرقة" : "Sélectionner"}</option>
                            {dispatchType === 'protection_civile' ? (
                              <>
                                <option value="unit_1">🚒 {isArabic ? "وحدة التدخل السريع 1" : "RAPIDE 1"}</option>
                                <option value="unit_2">🚒 {isArabic ? "وحدة الدعم والإسناد" : "SOUTIEN"}</option>
                                <option value="unit_3">🚒 {isArabic ? "وحدة الإنقاذ الجبلية" : "MONTAGNE"}</option>
                              </>
                            ) : (
                              <>
                                <option value="vol_1">💚 {isArabic ? "الهلال الأحمر الجزائري" : "CRA"}</option>
                                <option value="vol_2">💚 {isArabic ? "رابطة المتطوعين" : "Assoc"}</option>
                                <option value="vol_3">💚 {isArabic ? "فرقة الدراجات النارية" : "MOTO"}</option>
                              </>
                            )}
                          </select>

                          <button
                            type="button"
                            disabled={dispatchLoading || !selectedTeam}
                            onClick={() => handleDispatchSubmit(sos.id)}
                            className="w-full bg-red-600 hover:bg-red-500 disabled:bg-gray-800 disabled:text-gray-600 text-white font-bold rounded py-1 text-[9px] cursor-pointer"
                          >
                            {isArabic ? "إرسال الفرقة" : "Envoyer"}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setDispatchingSosId(sos.id);
                            setDispatchType('protection_civile');
                            setSelectedTeam('');
                            setDispatchNotes('');
                          }}
                          className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded py-1 text-[9px] cursor-pointer flex items-center justify-center gap-1"
                        >
                          <Radio className="h-3 w-3 text-red-500 animate-pulse" />
                          <span>{isArabic ? "توجيه نجدة للمحاصر" : "Dépêcher secours"}</span>
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 pt-1 border-t border-white/5">
                      <button
                        onClick={() => {
                          if (mapInstance.current) {
                            mapInstance.current.setView([sos.lat, sos.lng], 15);
                            L.popup()
                              .setLatLng([sos.lat, sos.lng])
                              .setContent(`
                                <div class="text-xs font-mono">
                                  <strong style="color:#ef4444;">🚨 SOS: ${sos.name}</strong><br/>
                                  ${sos.phone ? `Tél: ${sos.phone}` : ""}
                                </div>
                              `)
                              .openOn(mapInstance.current);
                          }
                        }}
                        className="flex-1 bg-black/40 hover:bg-zinc-800 text-slate-300 font-bold border border-white/10 rounded py-1 text-[9px] cursor-pointer flex items-center justify-center gap-0.5"
                      >
                        <MapPin className="h-2.5 w-2.5 text-red-500" />
                        <span>{isArabic ? "تحديد" : "Cibler"}</span>
                      </button>

                      <button
                        onClick={async () => {
                          if (confirm(isArabic ? `تأكيد إنقاذ ${sos.name} وحل الاستغاثة؟` : `Marquer ${sos.name} comme secouru ?`)) {
                            try {
                              const res = await fetch(`/api/sos/${sos.id}/resolve`, { method: "POST" });
                              if (res.ok && onRefresh) onRefresh();
                            } catch (err) { console.error(err); }
                          }
                        }}
                        className="flex-1 bg-emerald-650 hover:bg-emerald-600 text-white font-bold rounded py-1 text-[9px] cursor-pointer flex items-center justify-center gap-0.5"
                      >
                        <Check className="h-3 w-3" />
                        <span>{isArabic ? "تم الإنقاذ" : "Sauvé"}</span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Activity Feed */}
          <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)] flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-xs font-bold text-slate-300">
                {isArabic ? "النشاط الميداني" : "Flux d'activité mieldien"}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto max-h-[220px] p-3 space-y-2">
              {reports.slice(0, 30).map((rep) => (
                <div key={rep.id} className="bg-black/40 rounded-lg p-2.5 border border-white/5 text-[11px] space-y-1 text-start">
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
      </div>

      {/* Rescue & Support Teams Panel & Dispatcher Table */}
      <div className="bg-zinc-900/60 border border-white/5 rounded-xl shadow-[0_4px_25px_rgba(0,0,0,0.3)]">
        <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Truck className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-extrabold text-slate-200">
              {isArabic ? "جدول توجيه وإدارة فرق الإنقاذ" : "Tableau de Dispatch & Gestion des Équipes"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-gray-400">
            <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 px-2 py-0.5 rounded-full font-bold">
              {getTeamsStatusAndPositions().filter(t => t.status === "available").length} {isArabic ? "متاحة" : "Dispo"}
            </span>
            <span className="bg-amber-500/10 text-amber-400 border border-amber-500/25 px-2 py-0.5 rounded-full font-bold">
              {getTeamsStatusAndPositions().filter(t => t.status === "en_route").length} {isArabic ? "في الطريق" : "En route"}
            </span>
            <span className="bg-red-500/10 text-red-400 border border-red-500/25 px-2 py-0.5 rounded-full font-bold">
              {getTeamsStatusAndPositions().filter(t => t.status === "on_site").length} {isArabic ? "في الموقع" : "Sur site"}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-start">
            <thead>
              <tr className="border-b border-white/5 text-gray-500 text-[11px] uppercase tracking-wider font-semibold">
                <th className="px-4 py-3 text-start">{isArabic ? "الفرقة" : "Équipe"}</th>
                <th className="px-4 py-3 text-start">{isArabic ? "النوع" : "Type"}</th>
                <th className="px-4 py-3 text-start">{isArabic ? "الموقع الحالي" : "Localisation"}</th>
                <th className="px-4 py-3 text-start">{isArabic ? "الحالة" : "Statut"}</th>
                <th className="px-4 py-3 text-start min-w-[280px]">{isArabic ? "عملية التوجيه السريع" : "Dispatch Rapide"}</th>
              </tr>
            </thead>
            <tbody>
              {getTeamsStatusAndPositions().map((team) => {
                const teamName = isArabic ? team.teamNameAr : team.teamNameFr;
                const isPC = team.type === "protection_civile";
                const selectedSosIdForTeam = tableDispatchSosId[team.id] || "";
                const notesForTeam = tableDispatchNotes[team.id] || "";

                let statusBadge = "";
                let statusText = "";
                let statusIndicator = "bg-gray-400";

                if (team.status === "available") {
                  statusIndicator = "bg-emerald-500";
                  statusText = isArabic ? "متاح في المقر" : "Disponible à la base";
                  statusBadge = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
                } else if (team.status === "en_route") {
                  statusIndicator = "bg-amber-500 animate-pulse";
                  statusText = isArabic ? `في الطريق لنجدة ${team.assistedPerson} (~${team.remainingMin} د)` : `En route chez ${team.assistedPerson} (~${team.remainingMin}m)`;
                  statusBadge = "bg-amber-500/10 text-amber-400 border-amber-500/20";
                } else {
                  statusIndicator = "bg-red-500 animate-pulse";
                  statusText = isArabic ? `في الموقع ينجد ${team.assistedPerson}` : `Sur site avec ${team.assistedPerson}`;
                  statusBadge = "bg-red-500/10 text-red-400 border-red-500/20";
                }

                return (
                  <tr key={team.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    {/* Team Name */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="text-lg">{team.emoji}</span>
                        <div>
                          <p className="font-extrabold text-slate-100">{teamName}</p>
                          <p className="text-[10px] text-gray-500 font-mono">ID: {team.id}</p>
                        </div>
                      </div>
                    </td>

                    {/* Team Type */}
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                        isPC 
                          ? "bg-red-500/10 text-red-400 border-red-500/20" 
                          : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      }`}>
                        {isPC ? <Shield className="h-2.5 w-2.5" /> : <HeartHandshake className="h-2.5 w-2.5" />}
                        {isPC ? (isArabic ? "حماية مدنية" : "Protection Civile") : (isArabic ? "متطوعون" : "Volontaires")}
                      </span>
                    </td>

                    {/* Coordinates & Target Button */}
                    <td className="px-4 py-3 font-mono text-[11px] text-gray-400">
                      <div className="flex items-center gap-2">
                        <span>{team.currentLat.toFixed(4)}, {team.currentLng.toFixed(4)}</span>
                        <button
                          type="button"
                          onClick={() => handleTargetTeam(team.currentLat, team.currentLng, teamName, team.emoji, statusText)}
                          className="p-1 bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-amber-400 rounded transition-all cursor-pointer"
                          title={isArabic ? "تحديد الموقع على الخريطة" : "Localiser sur la carte"}
                        >
                          <MapPin className="h-3 w-3" />
                        </button>
                      </div>
                    </td>

                    {/* Live Status */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${statusIndicator}`} />
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-extrabold tracking-wide uppercase border ${statusBadge}`}>
                          {team.status === "available" ? (isArabic ? "متاح" : "DISPO") : team.status === "en_route" ? (isArabic ? "في الطريق" : "EN ROUTE") : (isArabic ? "في الموقع" : "SUR SITE")}
                        </span>
                      </div>
                    </td>

                    {/* Direct Dispatch Dropdown Form & Active Mission status */}
                    <td className="px-4 py-3">
                      {team.status === "available" ? (
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 max-w-sm">
                          <div className="flex-1 min-w-[140px]">
                            <select
                              value={selectedSosIdForTeam}
                              onChange={(e) => setTableDispatchSosId(prev => ({ ...prev, [team.id]: e.target.value }))}
                              className="w-full bg-zinc-950 border border-white/10 rounded px-2 py-1 text-[11px] text-slate-300 focus:outline-none"
                            >
                              <option value="">{isArabic ? "اختر بلاغ استغاثة..." : "Sélectionner SOS..."}</option>
                              {sosCalls.filter(s => s.status === "active").map((sos) => (
                                <option key={sos.id} value={sos.id}>
                                  🚨 {sos.name} ({new Date(sos.timestamp).toLocaleTimeString()})
                                </option>
                              ))}
                              {sosCalls.filter(s => s.status === "active").length === 0 && (
                                <option value="" disabled>{isArabic ? "لا توجد استغاثات نشطة" : "Aucun SOS actif"}</option>
                              )}
                            </select>
                          </div>

                          <div className="flex-1">
                            <input
                              type="text"
                              value={notesForTeam}
                              onChange={(e) => setTableDispatchNotes(prev => ({ ...prev, [team.id]: e.target.value }))}
                              placeholder={isArabic ? "تعليمات التوجيه (اختياري)..." : "Notes d'opération..."}
                              className="w-full bg-zinc-950 border border-white/10 rounded px-2 py-1 text-[11px] text-slate-300 placeholder:text-gray-600 focus:outline-none"
                            />
                          </div>

                          <button
                            type="button"
                            disabled={dispatchLoading || !selectedSosIdForTeam}
                            onClick={() => handleDirectDispatch(team.id, selectedSosIdForTeam, notesForTeam)}
                            className="bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-gray-500 disabled:border-zinc-800 border border-amber-500 text-black font-extrabold rounded px-3 py-1 text-[11px] transition-all cursor-pointer shrink-0 flex items-center gap-1"
                          >
                            <Truck className="h-3 w-3" />
                            <span>{isArabic ? "توجيه الفريق" : "Dépêcher"}</span>
                          </button>
                        </div>
                      ) : (
                        <div className="text-[11px] text-slate-300">
                          <p className="flex items-center gap-1 text-amber-400">
                            <Truck className="h-3 w-3" />
                            <span className="font-bold">{isArabic ? "مهمة جارية:" : "Mission active:"}</span>
                            <span className="text-slate-100 font-extrabold">{team.assistedPerson}</span>
                          </p>
                          {team.notes && (
                            <p className="text-[10px] text-gray-400 mt-1 italic max-w-xs truncate" title={team.notes}>
                              "{team.notes}"
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
