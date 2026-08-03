import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { MapPin, Users } from "lucide-react";
import { Report, SatelliteHotspot, TrappedSOS } from "../../types";
import { TeamStatus, getTeamStatusBadge } from "./teams";
import { UserLocationData } from "./StatCards";

interface FocusTarget {
  lat: number;
  lng: number;
  html: string;
}

interface CommandMapProps {
  isArabic: boolean;
  satellites: SatelliteHotspot[];
  activeUsers: UserLocationData[];
  reports: Report[];
  sosCalls: TrappedSOS[];
  teams: TeamStatus[];
  focus: FocusTarget | null;
}

function esc(value: unknown): string {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

export default function CommandMap({ isArabic, satellites, activeUsers, reports, sosCalls, teams, focus }: CommandMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const markersLayer = useRef<L.LayerGroup | null>(null);
  const [ticker, setTicker] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setTicker((t) => t + 1);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  // Initialize Leaflet map
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

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
  }, []);

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
          <strong>${isArabic ? "قمر صناعي" : "Satellite"}: ${esc(sat.satellite)}</strong><br/>
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
          <strong>${esc(u.name)}</strong><br/>
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
          <strong>${esc(rep.locationName)}</strong><br/>
          ${esc(rep.wilaya)}<br/>
          ${isArabic ? "الحالة" : "Statut"}: ${esc(rep.status)}<br/>
          ${esc(rep.description.substring(0, 80))}
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
          <strong>${esc(sos.name)}</strong><br/>
          ${isArabic ? "الهاتف" : "Tél"}: ${esc(sos.phone || (isArabic ? "غير متوفر" : "Non fourni"))}<br/>
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
    teams.forEach((t) => {
      const badge = getTeamStatusBadge(t, isArabic);

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
            <p><strong>${isArabic ? "الفرقة:" : "Équipe:"}</strong> ${isArabic ? esc(t.teamNameAr) : esc(t.teamNameFr)}</p>
            <p><strong>${isArabic ? "الحالة:" : "Statut:"}</strong> ${badge.text}</p>
            ${t.assistedPerson ? `<p><strong>${isArabic ? "المستغيث:" : "Assiste:"}</strong> ${esc(t.assistedPerson)}</p>` : ""}
            ${t.notes ? `<p><strong>${isArabic ? "ملاحظات:" : "Notes:"}</strong> ${esc(t.notes)}</p>` : ""}
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
  }, [activeUsers, satellites, reports, sosCalls, isArabic, ticker, teams]);

  // External focus target (e.g. from table "تحديد" buttons)
  useEffect(() => {
    if (focus && mapInstance.current) {
      mapInstance.current.setView([focus.lat, focus.lng], 13);
      L.popup()
        .setLatLng([focus.lat, focus.lng])
        .setContent(focus.html)
        .openOn(mapInstance.current);
    }
  }, [focus]);

  return (
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
  );
}
