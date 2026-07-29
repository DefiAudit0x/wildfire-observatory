import { useEffect, useRef } from "react";
import L from "leaflet";
import { Report, SatelliteHotspot } from "../types";

interface InteractiveMapProps {
  reports: Report[];
  satellites: SatelliteHotspot[];
  onMapClick: (lat: number, lng: number) => void;
  onConfirmReport: (id: string) => void;
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

  const isArabic = lang === "ar";

  // Initial map setup
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // Center map around Algeria (with focus on fire-prone northern regions)
    const map = L.map(mapContainerRef.current, {
      center: [35.5, 5.0],
      zoom: 6.5,
      zoomControl: true,
    });

    // Dark styled tile layer to look premium and high contrast
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);

    // Click handler for coordinates reporting
    map.on("click", (e: L.LeafletMouseEvent) => {
      onMapClick(e.latlng.lat, e.latlng.lng);
    });

    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [onMapClick]);

  // Update markers when reports or satellites change
  useEffect(() => {
    const map = mapRef.current;
    const markerGroup = markersRef.current;
    if (!map || !markerGroup) return;

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
            <p><strong>${isArabic ? "الولاية" : "Wilaya"}:</strong> ${sat.wilaya}</p>
            <p><strong>${isArabic ? "القمر الصناعي" : "Satellite"}:</strong> NASA ${sat.satellite}</p>
            <p><strong>${isArabic ? "شدة الحرارة" : "Luminosité"}:</strong> ${sat.brightness.toFixed(1)} K</p>
            <p><strong>${isArabic ? "نسبة التأكيد" : "Confiance"}:</strong> ${sat.confidence}%</p>
            <p><strong>${isArabic ? "توقيت الرصد" : "Heure de détection"}:</strong> ${new Date(sat.scanTime).toLocaleTimeString()}</p>
          </div>
          <p class="text-[10px] text-slate-400 mt-2 italic text-center">
            ${isArabic ? "مصدر البيانات: وكالة ناسا FIRMS" : "Source : NASA FIRMS Near Real-Time"}
          </p>
        </div>
      `;

      L.marker([sat.lat, sat.lng], { icon: satelliteIcon })
        .bindPopup(popupContent, { maxWidth: 300 })
        .addTo(markerGroup);
    });

    // 2. Plot citizen reports
    reports.forEach((rep) => {
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

      const color = getSeverityColor(rep.severity);

      // Custom pulsing orange div icon with color based on severity
      const citizenIcon = L.divIcon({
        className: "custom-citizen-icon",
        html: `
          <div class="relative flex items-center justify-center" style="width: 24px; height: 24px;">
            <div class="absolute rounded-full opacity-40 animate-ping" style="width: 24px; height: 24px; background-color: ${color};"></div>
            <div class="rounded-full shadow-lg border-2 border-white flex items-center justify-center text-white" style="width: 14px; height: 14px; background-color: ${color}; font-size: 8px;">
              ${rep.consensusCount}
            </div>
          </div>
        `,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const aiStatusHtml = rep.aiVerification
        ? `
          <div class="mt-2 bg-emerald-950/40 border border-emerald-500/30 rounded p-1.5 text-[11px] text-emerald-300">
            <div class="flex items-center gap-1 font-bold">
              <span>🤖 ${isArabic ? "تم التحقق بالذكاء الاصطناعي" : "Vérifié par l'IA"}</span>
              <span class="bg-emerald-500 text-slate-950 text-[9px] px-1 rounded">${rep.aiVerification.confidence}%</span>
            </div>
            <p class="mt-1 text-[10px] text-slate-300">${rep.aiVerification.aiComments}</p>
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
                ? `تم دمج ${rep.clusterSize} بلاغات متشابهة في نطاق 3 كلم للحد من التكرار.` 
                : `${rep.clusterSize} rapports fusionnés dans un rayon de 3km.`}
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
            <h4 class="font-bold text-slate-200 text-base leading-tight">${rep.locationName}</h4>
            <div class="flex items-center gap-1.5 flex-wrap mt-1">
              <span class="text-[10px] text-slate-400">${new Date(rep.timestamp).toLocaleTimeString()} | ${rep.wilaya}</span>
              ${getReporterBadgeHtml(rep.reporterType)}
            </div>
          </div>
          ${severityBadge}
        </div>
        <p class="text-xs text-slate-300 mt-2 bg-slate-900/60 p-2 rounded border border-slate-800 leading-relaxed">${rep.description}</p>
        
        ${rep.image ? `<img src="${rep.image}" class="w-full h-24 object-cover rounded mt-2 border border-slate-700" alt="Wildfire image" referrerPolicy="no-referrer" />` : ""}
        
        ${clusterHtml}
        ${aiStatusHtml}

        <div class="mt-3 flex items-center justify-between border-t border-slate-700 pt-2">
          <span class="text-[11px] text-slate-400">
            ${isArabic ? "تأكيدات المجتمع:" : "Confirmations:"} <strong>${rep.consensusCount}</strong>
          </span>
          <button id="upvote-btn-${rep.id}" class="px-2 py-1 bg-red-500/20 hover:bg-red-500 text-red-400 hover:text-white rounded text-xs transition-colors font-bold cursor-pointer flex items-center gap-1">
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

      marker.on("popupopen", () => {
        const btn = document.getElementById(`upvote-btn-${rep.id}`);
        if (btn) {
          btn.addEventListener("click", () => {
            onConfirmReport(rep.id);
            // Quick local visual update inside popup text
            const countEl = btn.parentElement?.querySelector("strong");
            if (countEl) {
              const currentVal = parseInt(countEl.textContent || "0", 10);
              countEl.textContent = String(currentVal + 1);
            }
            btn.setAttribute("disabled", "true");
            btn.className = "px-2 py-1 bg-slate-800 text-slate-500 rounded text-xs cursor-not-allowed";
            btn.textContent = isArabic ? "✓ تم التأكيد" : "✓ Confirmé";
          });
        }
      });
    });
  }, [reports, satellites, lang, onConfirmReport, isArabic]);

  // Handle flyTo when a selected report is clicked in list
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedReportId) return;

    const report = reports.find((r) => r.id === selectedReportId);
    if (report) {
      map.setView([report.lat, report.lng], 13, {
        animate: true,
        duration: 1.5,
      });
    }
  }, [selectedReportId, reports]);

  return (
    <div className="relative w-full h-full min-h-[300px] md:min-h-[450px] bg-slate-900 rounded-xl overflow-hidden shadow-2xl border border-slate-800">
      <div id="map-target" ref={mapContainerRef} className="w-full h-full" />
      
      {/* Absolute overlay indicator */}
      <div className="absolute top-3 right-3 z-[1000] bg-slate-950/95 border border-slate-800 backdrop-blur text-xs py-1.5 px-3 rounded-lg shadow-lg flex items-center gap-3">
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

      <div className="absolute bottom-3 left-3 z-[1000] bg-slate-950/90 text-[10px] text-slate-400 px-2 py-1 rounded border border-slate-800">
        {isArabic
          ? "💡 انقر على أي مكان بالخريطة لتحديد موقع وإبلاغ عن حريق"
          : "💡 Cliquez sur la carte pour épingler un feu"}
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
