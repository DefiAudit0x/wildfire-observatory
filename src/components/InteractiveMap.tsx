import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { Report, SatelliteHotspot } from "../types";

function esc(str: unknown): string {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function safeImageSrc(src: unknown): string {
  const value = String(src ?? "");
  if (value.startsWith("data:image/") || value.startsWith("https://")) return value;
  return "";
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface InteractiveMapProps {
  reports: Report[];
  satellites: SatelliteHotspot[];
  onMapClick: (lat: number, lng: number) => void;
  onConfirmReport: (id: string) => Promise<boolean>;
  selectedReportId: string | null;
  lang: "ar" | "fr";
}

export default function InteractiveMap({
  reports,
  satellites,
  onMapClick,
  onConfirmReport,
  selectedReportId,
  lang,
}: InteractiveMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const heatRef = useRef<L.LayerGroup | null>(null);
  const markersSigRef = useRef("");
  const heatSigRef = useRef("");
  const onMapClickRef = useRef(onMapClick);
  const onConfirmReportRef = useRef(onConfirmReport);
  const basemapsRef = useRef<Record<string, L.TileLayer>>({});
  const layerControlRef = useRef<L.Control.Layers | null>(null);
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(new Set(["low", "medium", "high", "critical"]));
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [heatEnabled, setHeatEnabled] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    onConfirmReportRef.current = onConfirmReport;
  }, [onConfirmReport]);

  const isArabic = lang === "ar";

  // Initial map setup (runs once on mount)
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // Center map around Algeria (with focus on fire-prone northern regions)
    const map = L.map(mapContainerRef.current, {
      center: [35.5, 5.0],
      zoom: 6,
      zoomControl: true,
    });

    const tileOptions = {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 19,
    };

    const lightLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", tileOptions);
    const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", tileOptions);
    const voyagerLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", tileOptions);

    // Default: light map (dark_all is nearly black, looks broken)
    lightLayer.addTo(map);

    basemapsRef.current = { light: lightLayer, dark: darkLayer, voyager: voyagerLayer };

    // Click handler for coordinates reporting
    map.on("click", (e: L.LeafletMouseEvent) => {
      onMapClickRef.current(e.latlng.lat, e.latlng.lng);
    });

    markersRef.current = L.layerGroup().addTo(map);
    heatRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setMapReady(true);

    // Ensure correct size if container dimensions change after mount
    setTimeout(() => {
      if (mapRef.current) mapRef.current.invalidateSize();
    }, 100);

    // v1.0.4 field fix ("الخريطة لم تعد تظهر"): the one-shot 100 ms timeout
    // could not recover from a 0-size mount (fast tab switch, WebView resume,
    // late layout). Leaflet then initialized at 0×0 and never self-corrected
    // — a permanently grey container. Continuous observation keeps the canvas
    // in sync with real layout changes (same pattern CommandMap already had).
    const container = mapContainerRef.current;
    let resizeObserver: ResizeObserver | null = null;
    if (container && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        mapRef.current?.invalidateSize();
      });
      resizeObserver.observe(container);
    }

    return () => {
      resizeObserver?.disconnect();
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      markersRef.current = null;
      heatRef.current = null;
      layerControlRef.current = null;
      basemapsRef.current = {};
      markersSigRef.current = "";
      heatSigRef.current = "";
      setMapReady(false);
    };
  }, []);

  // Rebuild only the control when language changes; tile layers stay intact.
  useEffect(() => {
    const map = mapRef.current;
    const layers = basemapsRef.current;
    if (!mapReady || !map || !layers.light || !layers.voyager || !layers.dark) return;

    if (layerControlRef.current) {
      map.removeControl(layerControlRef.current);
    }

    layerControlRef.current = L.control.layers(
      {
        [isArabic ? "فاتحة" : "Clair"]: layers.light,
        [isArabic ? "ملونة" : "Voyager"]: layers.voyager,
        [isArabic ? "داكنة" : "Sombre"]: layers.dark,
      },
      undefined,
      { position: "bottomright", collapsed: false }
    ).addTo(map);
  }, [isArabic, mapReady]);

  // Single delegated listener for all popup confirm buttons (no per-popup DOM listeners)
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    const handleClick = async (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target || !target.closest) return;
      const btn = target.closest("[data-confirm-report]") as HTMLElement | null;
      if (!btn) return;
      if (btn.hasAttribute("disabled") || btn.getAttribute("aria-busy") === "true") return;
      const reportId = btn.getAttribute("data-confirm-report");
      if (!reportId) return;
      btn.setAttribute("disabled", "true");
      btn.setAttribute("aria-busy", "true");
      try {
        const confirmed = await onConfirmReportRef.current(reportId);
        if (!confirmed) {
          btn.removeAttribute("disabled");
          return;
        }
        const countEl = btn.parentElement?.querySelector("strong");
        if (countEl) {
          const currentVal = parseInt(countEl.textContent || "0", 10);
          countEl.textContent = String(currentVal + 1);
        }
        btn.className = "px-2 py-1 bg-slate-800 text-slate-500 rounded text-xs cursor-not-allowed";
        btn.textContent = btn.getAttribute("data-done-text") || "✓";
      } catch {
        btn.removeAttribute("disabled");
      } finally {
        btn.removeAttribute("aria-busy");
      }
    };

    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, []);

  // Update markers only when the underlying data actually changed
  // (avoids clearing and rebuilding the whole map on every polling tick)
  useEffect(() => {
    const map = mapRef.current;
    const markerGroup = markersRef.current;
    if (!mapReady || !map || !markerGroup) return;

    // 2. Plot citizen reports (filtered)
    const visibleReports = reports.filter(
      (r) => severityFilter.has(r.severity) && (statusFilter === "all" || r.status === statusFilter)
    );

    const getSeverityColor = (sev: string) => {
      switch (sev) {
        case "critical":
          return "#ef4444"; // red
        case "high":
          return "#f97316"; // orange
        case "medium":
          return "#f59e0b"; // amber
        default:
          return "#10b981"; // green
      }
    };

    // Heat layer toggle/refresh is tracked separately from markers
    const heatLayer = heatRef.current;
    const heatSig = `${heatEnabled ? 1 : 0}|${visibleReports.map((r) => `${r.id}:${r.lat}:${r.lng}:${r.severity}:${r.status}`).join(",")}`;
    if (heatSig !== heatSigRef.current && heatLayer) {
      heatSigRef.current = heatSig;
      heatLayer.clearLayers();
      if (heatEnabled) {
        visibleReports.forEach((rep) => {
          const weight = rep.severity === "critical" ? 0.5 : rep.severity === "high" ? 0.38 : rep.severity === "medium" ? 0.26 : 0.16;
          L.circle([rep.lat, rep.lng], {
            radius: 900,
            color: getSeverityColor(rep.severity),
            weight: 0,
            fillColor: getSeverityColor(rep.severity),
            fillOpacity: weight,
            interactive: false,
          }).addTo(heatLayer);
        });
      }
    }

    const markerSig = [
      satellites
        .map((s) => `${s.id}|${s.lat}|${s.lng}|${s.brightness}|${s.confidence}|${s.scanTime}|${s.wilaya}|${s.satellite}`)
        .join(";"),
      visibleReports
        .map((r) =>
          `${r.id}|${r.lat}|${r.lng}|${r.severity}|${r.status}|${r.locationName}|${r.wilaya}|${r.timestamp}|${r.description}|${r.image || ""}|${r.reporterType || ""}|${r.consensusCount}|${r.clusterSize || 0}|${r.clusterId || ""}|${r.isClusterLeader ? 1 : 0}|${r.aiVerification?.isVerified ? 1 : 0}|${r.aiVerification?.confidence || ""}|${r.aiVerification?.aiComments || ""}|${r.aiVerification?.suggestedSeverity || ""}|${r.aiVerification?.detectedSigns?.join(",") || ""}|${isArabic ? 1 : 0}`
        )
        .join(";"),
    ].join("~");
    if (markerSig === markersSigRef.current) return;
    markersSigRef.current = markerSig;

    markerGroup.clearLayers();

    // 1. Plot NASA satellite thermal spots (MODIS/VIIRS)
    satellites.forEach((sat) => {
      // Custom pulsing red div icon
      const satelliteIcon = L.divIcon({
        className: "custom-satellite-icon",
        html: `<div class="satellite-pulse"><div class="satellite-pulse-dot"></div></div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const popupContent = `
        <div class="p-2 text-slate-100 text-sm font-sans" dir="${isArabic ? "rtl" : "ltr"}">
          <div class="flex items-center gap-2 mb-1">
            <span class="flex h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse"></span>
            <strong class="text-red-400 font-bold text-base">
              ${isArabic ? "رصد حراري بالأقمار الصناعية" : "Alerte Thermique Satellite"}
            </strong>
          </div>
          <div class="space-y-1 mt-2 text-xs border-t border-slate-700 pt-2 text-slate-300">
            <p><strong>${isArabic ? "الولاية" : "Wilaya"}:</strong> ${esc(sat.wilaya)}</p>
            <p><strong>${isArabic ? "القمر الصناعي" : "Satellite"}:</strong> NASA ${esc(sat.satellite)}</p>
            <p><strong>${isArabic ? "الإحداثيات" : "Coordonnées"}:</strong> ${safeNumber(sat.lat).toFixed(4)}, ${safeNumber(sat.lng).toFixed(4)}</p>
            <p><strong>${isArabic ? "شدة الحرارة" : "Luminosité"}:</strong> ${safeNumber(sat.brightness).toFixed(1)} K</p>
            <p><strong>${isArabic ? "نسبة التأكيد" : "Confiance"}:</strong> ${safeNumber(sat.confidence)}%</p>
            <p><strong>${isArabic ? "آخر تحديث" : "Dernière mise à jour"}:</strong> ${esc(new Date(sat.scanTime).toLocaleString(isArabic ? "ar-DZ" : "fr-FR"))}</p>
          </div>
          ${sat.isFallback ? `<p class="mt-2 bg-amber-500/10 border border-amber-500/30 rounded p-1.5 text-[9px] text-amber-400 text-center">⚠️ ${isArabic ? "بيانات احتياطية (تعذر وصول NASA حالياً)" : "Données de secours (NASA actuellement indisponible)"}</p>` : ""}
          <p class="text-[10px] text-slate-400 mt-2 italic text-center">
            ${isArabic ? "مصدر البيانات: وكالة ناسا FIRMS" : "Source : NASA FIRMS Near Real-Time"}
          </p>
        </div>
      `;

      L.marker([sat.lat, sat.lng], { icon: satelliteIcon })
        .bindPopup(popupContent, { maxWidth: 300 })
        .addTo(markerGroup);
    });

    visibleReports.forEach((rep) => {
      const color = getSeverityColor(rep.severity);

      // Custom pulsing orange div icon with color based on severity
      const citizenIcon = L.divIcon({
        className: "custom-citizen-icon",
        html: `
          <div class="relative flex items-center justify-center pointer-events-none" style="width: 24px; height: 24px;">
            <div class="absolute rounded-full opacity-40 animate-ping pointer-events-none" style="width: 24px; height: 24px; background-color: ${color};"></div>
            <div class="rounded-full shadow-lg border-2 border-white flex items-center justify-center text-white" style="width: 14px; height: 14px; background-color: ${color}; font-size: 8px;">
              ${safeNumber(rep.consensusCount)}
            </div>
          </div>
        `,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const aiStatusHtml = rep.aiVerification?.isVerified === true
        ? `
          <div class="mt-2 bg-emerald-950/40 border border-emerald-500/30 rounded p-1.5 text-[11px] text-emerald-300">
            <div class="flex items-center gap-1 font-bold">
              <span>🤖 ${isArabic ? "تم التحقق بالذكاء الاصطناعي" : "Vérifié par l'IA"}</span>
              <span class="bg-emerald-500 text-slate-950 text-[9px] px-1 rounded">${esc(rep.aiVerification.confidence)}%</span>
            </div>
            <p class="mt-1 text-[10px] text-slate-300">${esc(rep.aiVerification.aiComments)}</p>
          </div>
        `
        : rep.aiVerification
        ? `
          <div class="mt-2 bg-amber-950/40 border border-amber-500/30 rounded p-1.5 text-[11px] text-amber-300">
            <div class="flex items-center gap-1 font-bold">
              <span>🤖 ${isArabic ? "تحليل الذكاء الاصطناعي غير حاسم" : "Analyse IA non conclue"}</span>
            </div>
            <p class="mt-1 text-[10px] text-slate-300">${esc(rep.aiVerification.aiComments)}</p>
          </div>
        `
        : `
          <div class="mt-2 bg-slate-800 border border-slate-700 rounded p-1.5 text-[10px] text-slate-300 text-center">
            ${isArabic ? "بانتظار مصادقة الذكاء الاصطناعي" : "En attente de validation par l'IA"}
          </div>
        `;

      const getReporterBadgeHtml = (type?: string) => {
        if (type === 'official') {
          return `
            <span class="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[9px] font-black">
              🛡️ ${isArabic ? "الحماية المدنية" : "Protection Civile"}
            </span>
          `;
        }
        if (type === 'volunteer') {
          return `
            <span class="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[9px] font-bold">
              💚 ${isArabic ? "متطوع معتمد" : "Bénévole Météo"}
            </span>
          `;
        }
        return `
          <span class="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800 border border-white/5 text-gray-400 text-[9px] font-medium">
            👤 ${isArabic ? "مواطن" : "Citoyen"}
          </span>
        `;
      };

      const clusterHtml = (rep.clusterSize && rep.clusterSize > 1)
        ? `
          <div class="mt-2 bg-orange-950/20 border border-orange-500/30 rounded p-1.5 text-[10px] text-orange-300">
            <span class="font-bold">📍 ${isArabic ? "بؤرة متزامنة جغرافياً (Geo-Cluster)" : "Geo-Cluster Actif"}</span>
            <p class="text-[9px] text-slate-300 mt-0.5">
              ${isArabic 
                ? `تم دمج ${safeNumber(rep.clusterSize)} بلاغات متشابهة في نطاق 3 كلم للحد من التكرار.` 
                : `${safeNumber(rep.clusterSize)} rapports fusionnés dans un rayon de 3km.`}
            </p>
          </div>
        `
        : '';

      const severityBadge = `
        <span class="px-1.5 py-0.5 text-[10px] rounded font-bold uppercase" style="background-color: ${color}20; color: ${color}; border: 1px solid ${color}40">
          ${isArabic ? getSeverityTextAr(rep.severity) : getSeverityTextFr(rep.severity)}
        </span>
      `;

      const popupContent = document.createElement("div");
      popupContent.dir = isArabic ? "rtl" : "ltr";
      popupContent.className = "p-2 text-slate-100 text-sm font-sans max-w-xs";
      popupContent.innerHTML = `
        <div class="flex items-start justify-between gap-2 mb-1">
          <div>
            <h4 class="font-bold text-slate-200 text-base leading-tight">${esc(rep.locationName)}</h4>
            <div class="flex items-center gap-1.5 flex-wrap mt-1">
              <span class="text-[10px] text-slate-400">${new Date(rep.timestamp).toLocaleTimeString()} | ${esc(rep.wilaya)}</span>
              ${getReporterBadgeHtml(rep.reporterType)}
            </div>
          </div>
          ${severityBadge}
        </div>
        <p class="text-xs text-slate-300 mt-2 bg-slate-900/60 p-2 rounded border border-slate-800 leading-relaxed">${esc(rep.description)}</p>
        
        ${rep.image ? `<img src="${safeImageSrc(rep.image)}" class="w-full h-24 object-cover rounded mt-2 border border-slate-700" alt="Wildfire image" referrerPolicy="no-referrer" />` : ""}
        
        ${clusterHtml}
        ${aiStatusHtml}

        <div class="mt-3 flex items-center justify-between border-t border-slate-700 pt-2">
          <span class="text-[11px] text-slate-400">
            ${isArabic ? "تأكيدات المجتمع:" : "Confirmations:"} <strong>${rep.consensusCount}</strong>
          </span>
          <button data-confirm-report="${esc(rep.id)}" data-done-text="${isArabic ? "✓ تم التأكيد" : "✓ Confirmé"}" class="px-2 py-1 bg-red-500/20 hover:bg-red-500 text-red-400 hover:text-white rounded text-xs transition-colors font-bold cursor-pointer flex items-center gap-1">
            🔥 ${isArabic ? "تأكيد وجود حريق" : "Confirmer le feu"}
          </button>
        </div>
      `;

      // Draw cluster bounds circle if it's the leader and is part of a multi-report cluster
      if (rep.isClusterLeader && rep.clusterId && rep.clusterSize && rep.clusterSize > 1) {
        L.circle([rep.lat, rep.lng], {
          radius: 1500, // 1.5km radius for a 3km diameter cluster
          color: color,
          weight: 1.5,
          opacity: 0.8,
          dashArray: "4, 6",
          fillColor: color,
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(markerGroup);
      }

      // Attach click handler for upvote inside popup
      const marker = L.marker([rep.lat, rep.lng], { icon: citizenIcon })
        .bindPopup(popupContent, { maxWidth: 300 })
        .addTo(markerGroup);
    });
  }, [reports, satellites, lang, isArabic, severityFilter, statusFilter, mapReady]);

  // Handle flyTo when a selected report is clicked in list
  // ARC-H10 fix: this effect depended on the `reports` array identity, which is
  // replaced on every poll tick (10s/60s) — re-yanking the citizen's viewport
  // back to the selected report every 10 seconds during active incidents. The
  // effect now runs on genuine selection changes only, reading the latest
  // reports through a ref.
  const reportsForFlyRef = useRef(reports);
  useEffect(() => {
    reportsForFlyRef.current = reports;
  }, [reports]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedReportId) return;

    const report = reportsForFlyRef.current.find((r) => r.id === selectedReportId);
    if (report) {
      map.setView([report.lat, report.lng], 13, {
        animate: true,
        duration: 1.5,
      });
    }
  }, [selectedReportId]);

  return (
    <div className="relative w-full h-[300px] md:h-[450px] bg-slate-900 rounded-xl overflow-hidden shadow-2xl border border-slate-800">
      <div id="map-target" ref={mapContainerRef} className="absolute inset-0" />
      
      {/* Absolute overlay indicator */}
      <div className="absolute top-3 right-3 z-[1000] bg-slate-950/95 border border-slate-800 backdrop-blur text-xs py-1.5 px-3 rounded-lg shadow-lg flex items-center gap-3 pointer-events-none">
        <div className="flex items-center gap-1.5">
          <span className="flex h-2 w-2 rounded-full bg-red-500 animate-pulse"></span>
          <span className="text-slate-300 font-medium">
            {isArabic ? "الأقمار الصناعية (NASA)" : "Satellite (NASA)"}
          </span>
        </div>
        <div className="w-px h-3 bg-slate-800"></div>
        <div className="flex items-center gap-1.5">
          <span className="flex h-2 w-2 rounded-full bg-amber-500"></span>
          <span className="text-slate-300 font-medium">
            {isArabic ? "بلاغات المجتمع" : "Citoyens"}
          </span>
        </div>
      </div>

      <div className="absolute bottom-3 left-3 z-[1000] bg-slate-950/90 text-[10px] text-slate-400 px-2 py-1 rounded border border-slate-800 pointer-events-none">
        {isArabic
          ? "💡 انقر على أي مكان بالخريطة لتحديد موقع وإبلاغ عن حريق"
          : "💡 Cliquez sur la carte pour épingler un feu"}
      </div>

      {/* Map Filters Toolbar */}
      <div className="absolute top-3 left-3 z-[1000] bg-slate-950/95 border border-slate-800 backdrop-blur rounded-lg p-2 shadow-lg space-y-1.5 max-w-[210px]">
        <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">
          {isArabic ? "فلاتر العرض" : "Filtres"}
        </p>
        <div className="flex items-center gap-1 flex-wrap">
          {(["critical", "high", "medium", "low"] as const).map((sev) => {
            const active = severityFilter.has(sev);
            const colors: Record<string, string> = {
              critical: "#ef4444",
              high: "#f97316",
              medium: "#f59e0b",
              low: "#10b981",
            };
            return (
              <button
                key={sev}
                type="button"
                onClick={() => {
                  const next = new Set(severityFilter);
                  if (next.has(sev)) {
                    next.delete(sev);
                  } else {
                    next.add(sev);
                  }
                  setSeverityFilter(next);
                }}
                className={`px-1.5 py-0.5 rounded text-[9px] font-bold border transition-all cursor-pointer ${
                  active ? "text-white" : "text-slate-500 border-slate-800"
                }`}
                style={active ? { backgroundColor: `${colors[sev]}33`, borderColor: colors[sev] } : undefined}
              >
                {isArabic
                  ? { critical: "كارثي", high: "مرتفع", medium: "متوسط", low: "خفيف" }[sev]
                  : { critical: "Crit.", high: "Élevé", medium: "Moyen", low: "Faible" }[sev]}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="flex-1 bg-slate-900 border border-slate-800 rounded text-[9px] text-slate-300 px-1.5 py-1 focus:outline-none"
          >
            {(["all", "pending", "verified", "resolved", "rejected"] as const).map((st) => (
              <option key={st} value={st}>
                {st === "all"
                  ? (isArabic ? "كل الحالات" : "Tous")
                  : (isArabic ? { pending: "قيد الانتظار", verified: "مؤكد", resolved: "محلول", rejected: "مرفوض" }[st] : st)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setHeatEnabled((v) => !v)}
            className={`px-2 py-1 rounded text-[9px] font-bold border transition-all cursor-pointer ${
              heatEnabled
                ? "bg-orange-500/20 text-orange-400 border-orange-500/40"
                : "bg-slate-900 text-slate-500 border-slate-800 hover:text-slate-300"
            }`}
          >
            {isArabic ? "🔥 حرارة" : "🔥 Chaleur"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Helpers for Arabic/French severity tags
function getSeverityTextAr(sev: string) {
  switch (sev) {
    case "critical":
      return "كارثي 🚨";
    case "high":
      return "مرتفع ⚠️";
    case "medium":
      return "متوسط 🟡";
    default:
      return "خفيف 🟢";
  }
}

function getSeverityTextFr(sev: string) {
  switch (sev) {
    case "critical":
      return "Critique 🚨";
    case "high":
      return "Élevé ⚠️";
    case "medium":
      return "Moyen 🟡";
    default:
      return "Faible 🟢";
  }
}
