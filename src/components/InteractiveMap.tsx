import { useState, useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { Report, SatelliteHotspot, TrappedSOS } from "../types";

interface InteractiveMapProps {
  reports: Report[];
  satellites: SatelliteHotspot[];
  sosCalls?: TrappedSOS[];
  onMapClick: (lat: number, lng: number) => void;
  onConfirmReport: (id: string) => void;
  selectedReportId: string | null;
  lang: "ar" | "fr";
  userLocation?: { lat: number; lng: number } | null;
}

type TileStyle = "dark" | "osm" | "satellite";

export default function InteractiveMap({
  reports,
  satellites,
  sosCalls = [],
  onMapClick,
  onConfirmReport,
  selectedReportId,
  lang,
  userLocation
}: InteractiveMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const markersRef = useRef<L.MarkerClusterGroup | null>(null);
  const [tileStyle, setTileStyle] = useState<TileStyle>("dark");

  const isArabic = lang === "ar";
  const hasCenteredRef = useRef(false);

  // Real-time dispatched teams & Wind layer state & refs
  const [ticker, setTicker] = useState(0);
  const [showWindOverlay, setShowWindOverlay] = useState(true);
  const [windDataMap, setWindDataMap] = useState<{ [key: string]: { speed: number; dir: number } }>({});
  const dispatchedLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const windLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const activeDispatchLayersRef = useRef<{ [teamKey: string]: { marker: L.Marker; polyline: L.Polyline; startMarker: L.CircleMarker } }>({});
  const routeCacheRef = useRef<{ [teamKey: string]: [number, number][] }>({});

  useEffect(() => {
    const timer = setInterval(() => {
      setTicker((prev) => prev + 1);
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  // Tile Layer URLs
  const getTileUrl = (style: TileStyle) => {
    switch (style) {
      case "osm":
        return "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
      case "satellite":
        return "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
      case "dark":
      default:
        return "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
    }
  };

  const getTileAttribution = (style: TileStyle) => {
    switch (style) {
      case "osm":
        return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
      case "satellite":
        return 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community';
      case "dark":
      default:
        return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
    }
  };

  // Switch Tile Layer when tileStyle changes
  useEffect(() => {
    if (!mapRef.current) return;
    if (tileLayerRef.current) {
      mapRef.current.removeLayer(tileLayerRef.current);
    }

    const newLayer = L.tileLayer(getTileUrl(tileStyle), {
      attribution: getTileAttribution(tileStyle),
      subdomains: tileStyle === "dark" ? "abcd" : "abc",
      maxZoom: 19,
    });

    // Fallback to OSM if CartoDB dark tiles error out
    newLayer.on("tileerror", () => {
      console.warn(`Tile loading error for ${tileStyle}. Falling back to OpenStreetMap.`);
      if (tileStyle === "dark") {
        setTileStyle("osm");
      }
    });

    newLayer.addTo(mapRef.current);
    tileLayerRef.current = newLayer;
  }, [tileStyle]);

  // Use a ref for onMapClick to avoid recreating the map on every render
  const onMapClickRef = useRef(onMapClick);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  // Initial map setup
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // Center map around Algeria (with focus on fire-prone northern regions)
    const map = L.map(mapContainerRef.current, {
      center: [35.5, 5.0],
      zoom: 6.5,
      zoomControl: true,
      preferCanvas: true,
    });

    // Default tile layer
    const layer = L.tileLayer(getTileUrl("dark"), {
      attribution: getTileAttribution("dark"),
      subdomains: "abcd",
      maxZoom: 19,
    });

    layer.on("tileerror", () => {
      console.warn("CartoDB dark tiles errored on load, switching to OpenStreetMap");
      setTileStyle("osm");
    });

    layer.addTo(map);
    tileLayerRef.current = layer;

    // Click handler for coordinates reporting
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (onMapClickRef.current) {
        onMapClickRef.current(e.latlng.lat, e.latlng.lng);
      }
    });

    // @ts-ignore
    markersRef.current = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
    }).addTo(map);

    dispatchedLayerGroupRef.current = L.layerGroup().addTo(map);
    windLayerGroupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Invalidate map size after DOM mount and delayed timeouts to ensure correct render
    map.invalidateSize();
    const t1 = setTimeout(() => map.invalidateSize(), 150);
    const t2 = setTimeout(() => map.invalidateSize(), 500);

    // ResizeObserver for responsive resizing
    const resizeObserver = new ResizeObserver(() => {
      if (mapRef.current && mapContainerRef.current && mapContainerRef.current.offsetWidth > 0) {
        mapRef.current.invalidateSize();
      }
    });
    if (mapContainerRef.current) {
      resizeObserver.observe(mapContainerRef.current);
    }

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      resizeObserver.disconnect();
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      dispatchedLayerGroupRef.current = null;
      windLayerGroupRef.current = null;
      activeDispatchLayersRef.current = {};
    };
  }, []);

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
    // 3. Draw User Marker
    if (userLocation) {
      const userIcon = L.divIcon({
        className: "custom-nav-user-icon",
        html: `
          <div class="relative flex items-center justify-center w-6 h-6">
            <div class="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-50"></div>
            <div class="relative z-10 w-3 h-3 bg-blue-600 rounded-full border-2 border-white"></div>
          </div>
        `,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      L.marker([userLocation.lat, userLocation.lng], { icon: userIcon })
        .bindTooltip(isArabic ? "موقعك الحالي" : "Votre position", { permanent: false })
        .addTo(markerGroup);
    }

    // 4. Plot Active SOS Calls & Rescue Routes
    sosCalls.forEach((sos) => {
      if (sos.status !== "active") return;

      const sosIcon = L.divIcon({
        className: "custom-sos-icon",
        html: `
          <div class="relative flex items-center justify-center" style="width: 36px; height: 36px;">
            <div class="absolute inset-0 bg-red-600 rounded-full animate-ping opacity-75" style="animation-duration: 0.8s;"></div>
            <div class="absolute inset-2 bg-red-500 rounded-full animate-pulse"></div>
            <div class="relative z-10 h-7 w-7 bg-red-700 text-white border-2 border-white rounded-full flex items-center justify-center shadow-lg">
              <span class="font-black text-[9px] tracking-tighter">SOS</span>
            </div>
          </div>
        `,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      });

      const popupContent = `
        <div class="p-2.5 text-slate-100 font-sans" dir="${isArabic ? "rtl" : "ltr"}">
          <div class="flex items-center gap-2 mb-1.5 bg-red-950/40 p-1.5 rounded border border-red-500/30">
            <span class="flex h-3 w-3 rounded-full bg-red-500 animate-ping shrink-0"></span>
            <strong class="text-red-400 font-extrabold text-xs uppercase">
              ${isArabic ? "نداء استغاثة: شخص محاصر" : "SOS : Personne Piégée"}
            </strong>
          </div>
          <div class="space-y-1 mt-2 text-xs text-slate-300">
            <p><strong>${isArabic ? "الاسم" : "Nom"}:</strong> ${sos.name}</p>
            ${sos.phone ? `<p><strong>${isArabic ? "الهاتف" : "Tél"}:</strong> ${sos.phone}</p>` : ""}
            <p><strong>${isArabic ? "توقيت النداء" : "Heure"}:</strong> ${new Date(sos.timestamp).toLocaleTimeString()}</p>
            <p><strong>${isArabic ? "الإحداثيات" : "Coordonnées"}:</strong> ${sos.lat.toFixed(4)}, ${sos.lng.toFixed(4)}</p>
          </div>
          <div class="mt-3 pt-2 border-t border-slate-700 flex flex-col gap-1.5">
            <p class="text-[9px] text-yellow-400 leading-snug">
              ⚠️ ${isArabic 
                ? "تظهر المسارات الميدانية الأسرع لفرق الحماية المدنية والمتطوعين للوصول للموقع." 
                : "Les routes d'intervention les plus rapides sont tracées ci-dessous."}
            </p>
            <button id="resolve-sos-btn-${sos.id}" class="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 text-slate-100 rounded text-xs font-bold transition-colors flex items-center justify-center gap-1 cursor-pointer border-none">
              ✓ ${isArabic ? "تم تأكيد الإنقاذ / الإخلاء" : "Marquer comme sauvé"}
            </button>
          </div>
        </div>
      `;

      const marker = L.marker([sos.lat, sos.lng], { icon: sosIcon })
        .bindPopup(popupContent, { maxWidth: 280 })
        .addTo(markerGroup);

      marker.on("popupopen", () => {
        const btn = document.getElementById(`resolve-sos-btn-${sos.id}`);
        if (btn) {
          btn.addEventListener("click", async () => {
            try {
              const res = await fetch(`/api/sos/${sos.id}/resolve`, { method: "POST" });
              if (res.ok) {
                marker.closePopup();
                btn.setAttribute("disabled", "true");
                btn.className = "py-1.5 bg-slate-800 text-slate-500 text-xs rounded font-bold cursor-not-allowed w-full";
                btn.textContent = isArabic ? "✓ تم الإنقاذ" : "✓ Sauvé";
              }
            } catch (err) {
              console.error("Failed to resolve SOS:", err);
            }
          });
        }
      });
    });
  }, [reports, satellites, lang, onConfirmReport, isArabic, userLocation, sosCalls]);

  // Update dispatched teams' positions on map ticker
  useEffect(() => {
    const map = mapRef.current;
    const group = dispatchedLayerGroupRef.current;
    if (!map || !group) return;

    const activeKeys = new Set<string>();

    sosCalls.forEach((sos) => {
      if (sos.status !== "active") return;

      // Draw user route if they are volunteer/official
      if (userLocation) {
        const userRole = localStorage.getItem("userRole") || "citizen";
        if (userRole === "volunteer" || userRole === "official") {
          const teamKey = `${sos.id}_user_responder`;
          activeKeys.add(teamKey);

          const startLat = userLocation.lat;
          const startLng = userLocation.lng;
          
          let layers = activeDispatchLayersRef.current[teamKey];
          const color = userRole === "official" ? "#ef4444" : "#10b981";
          const emoji = userRole === "official" ? "🚒" : "💚";
          const label = userRole === "official" 
            ? (isArabic ? "مسار شاحنتك (الحماية المدنية)" : "Votre Camion") 
            : (isArabic ? "مسارك الميداني (متطوع)" : "Votre Trajet");

          if (!layers) {
            const startMarker = L.circleMarker([startLat, startLng], {
              radius: 6,
              color: color,
              fillColor: "#ffffff",
              fillOpacity: 1,
              weight: 2
            }).bindTooltip(label, { permanent: false, direction: "top" }).addTo(group);

            const polyline = L.polyline([[startLat, startLng], [sos.lat, sos.lng]], {
              color: color,
              weight: 4.5,
              opacity: 0.85,
            }).addTo(group);

            const vehicleIcon = L.divIcon({
              className: "custom-nav-user-dispatch",
              html: `
                <div class="relative flex items-center justify-center" style="width: 32px; height: 32px;">
                  <div class="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-30"></div>
                  <div class="relative z-10 h-7 w-7 rounded-full flex items-center justify-center shadow-lg border-2 bg-blue-600 border-white">
                    <span class="text-sm">${emoji}</span>
                  </div>
                </div>
              `,
              iconSize: [32, 32],
              iconAnchor: [16, 16]
            });

            const marker = L.marker([startLat, startLng], { icon: vehicleIcon })
              .bindTooltip(isArabic ? "موقعك (متوجه للنجدة)" : "Votre position (En route)", { permanent: true, direction: "bottom" })
              .addTo(group);

            activeDispatchLayersRef.current[teamKey] = { marker, polyline, startMarker };
          } else {
            layers.marker.setLatLng([startLat, startLng]);
            layers.polyline.setLatLngs([[startLat, startLng], [sos.lat, sos.lng]]);
          }
        }
      }

      // Draw all actually dispatched teams for this active SOS
      if (sos.dispatchedTeams && sos.dispatchedTeams.length > 0) {
        sos.dispatchedTeams.forEach((team) => {
          const teamKey = `${sos.id}_${team.teamNameFr}`;
          activeKeys.add(teamKey);

          const offset = getTeamStartOffset(team.teamNameFr);
          const startLat = sos.lat + offset.dLat;
          const startLng = sos.lng + offset.dLng;

          let dispatchedTime = Date.now();
          if (team.dispatchedAt) {
            if (typeof team.dispatchedAt === "string") {
              dispatchedTime = new Date(team.dispatchedAt).getTime();
            } else if (typeof team.dispatchedAt === "object" && (team.dispatchedAt as any).seconds) {
              dispatchedTime = (team.dispatchedAt as any).seconds * 1000;
            } else {
              dispatchedTime = new Date(team.dispatchedAt).getTime();
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

          if (!routeCacheRef.current[teamKey]) {
            routeCacheRef.current[teamKey] = [[startLat, startLng], [sos.lat, sos.lng]];

            fetch(`https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${sos.lng},${sos.lat}?overview=full&geometries=geojson`)
              .then(res => res.json())
              .then(data => {
                if (data.routes && data.routes.length > 0) {
                  const coords = data.routes[0].geometry.coordinates.map((c: any) => [c[1], c[0]] as [number, number]);
                  routeCacheRef.current[teamKey] = coords;
                }
              })
              .catch(() => {});
          }

          const coords = routeCacheRef.current[teamKey] || [[startLat, startLng], [sos.lat, sos.lng]];
          let idx = Math.floor(coords.length * progress);
          if (isNaN(idx) || idx < 0) idx = 0;
          if (idx >= coords.length) idx = coords.length - 1;

          const currentLat = coords[idx] ? coords[idx][0] : sos.lat;
          const currentLng = coords[idx] ? coords[idx][1] : sos.lng;

          const remainingRoute = coords.slice(idx);
          const polylineCoords = (remainingRoute.length >= 2 ? remainingRoute : [[currentLat, currentLng], [sos.lat, sos.lng]]) as L.LatLngTuple[];
          const color = team.type === "protection_civile" ? "#ef4444" : "#10b981";
          const emoji = team.type === "protection_civile" ? "🚒" : "💚";

          let layers = activeDispatchLayersRef.current[teamKey];
          if (!layers) {
            const startLabel = team.type === "protection_civile" 
              ? (isArabic ? "مركز الحماية المدنية" : "Poste Protection Civile") 
              : (isArabic ? "مقر الهلال الأحمر" : "Poste Croissant-Rouge");

            const startMarker = L.circleMarker([startLat, startLng], {
              radius: 5,
              color: color,
              fillColor: "#ffffff",
              fillOpacity: 1,
              weight: 2
            }).bindTooltip(startLabel, { direction: "top" }).addTo(group);

            const polyline = L.polyline(polylineCoords, {
              color: color,
              weight: 3.5,
              opacity: 0.8,
              dashArray: "5, 8"
            }).addTo(group);

            const vehicleIcon = L.divIcon({
              className: "custom-dispatched-vehicle",
              html: `
                <div class="relative flex items-center justify-center" style="width: 32px; height: 32px;">
                  <div class="absolute inset-0 bg-white rounded-full animate-ping opacity-25" style="animation-duration: 1.5s;"></div>
                  <div class="relative z-10 h-7 w-7 rounded-full flex items-center justify-center shadow-lg border-2" style="background-color: ${color}; border-color: #ffffff;">
                    <span class="text-sm">${emoji}</span>
                  </div>
                </div>
              `,
              iconSize: [32, 32],
              iconAnchor: [16, 16]
            });

            const marker = L.marker([currentLat, currentLng], { icon: vehicleIcon }).addTo(group);

            const remainingMin = Math.ceil((duration - elapsed) / 60000);
            const popupContent = createVehiclePopupContent(team, progress, remainingMin, isArabic);
            marker.bindPopup(popupContent, { maxWidth: 260 });

            marker.on("click", () => {
              map.setView([currentLat, currentLng], 14);
            });

            activeDispatchLayersRef.current[teamKey] = { marker, polyline, startMarker };
          } else {
            layers.marker.setLatLng([currentLat, currentLng]);
            layers.polyline.setLatLngs(polylineCoords);

            const remainingMin = Math.ceil((duration - elapsed) / 60000);
            const popupContent = createVehiclePopupContent(team, progress, remainingMin, isArabic);
            layers.marker.setPopupContent(popupContent);
          }
        });
      }
    });

    Object.keys(activeDispatchLayersRef.current).forEach((key) => {
      if (!activeKeys.has(key)) {
        const layers = activeDispatchLayersRef.current[key];
        if (layers) {
          group.removeLayer(layers.marker);
          group.removeLayer(layers.polyline);
          group.removeLayer(layers.startMarker);
        }
        delete activeDispatchLayersRef.current[key];
      }
    });

  }, [sosCalls, ticker, isArabic, userLocation]);

  // Render Wind Vectors & Wildfire Spread Cones
  useEffect(() => {
    const windGroup = windLayerGroupRef.current;
    if (!windGroup) return;

    windGroup.clearLayers();
    if (!showWindOverlay) return;

    // Major meteorological weather stations across wildfire areas
    const stations = [
      { nameAr: "بجاية (سيدي عيش)", nameFr: "Béjaïa (Sidi Aïch)", lat: 36.75, lng: 5.06, baseSpeed: 32, baseDir: 200 },
      { nameAr: "تيزي وزو (الأربعاء نيث إيراتن)", nameFr: "Tizi Ouzou (Larbaâ)", lat: 36.71, lng: 4.04, baseSpeed: 28, baseDir: 195 },
      { nameAr: "جيجل (زيامة منصورية)", nameFr: "Jijel (Ziama)", lat: 36.82, lng: 5.76, baseSpeed: 35, baseDir: 210 },
      { nameAr: "سكيكدة (فلفلة)", nameFr: "Skikda (Filfila)", lat: 36.87, lng: 6.90, baseSpeed: 30, baseDir: 185 },
      { nameAr: "القالة / الطارف", nameFr: "El Tarf (El Kala)", lat: 36.76, lng: 8.31, baseSpeed: 38, baseDir: 190 },
      { nameAr: "البويرة (الأخضرية)", nameFr: "Bouira (Lakhdaria)", lat: 36.37, lng: 3.90, baseSpeed: 26, baseDir: 205 },
      { nameAr: "المدية (الحمدانية)", nameFr: "Médéa (El Hamdania)", lat: 36.26, lng: 2.75, baseSpeed: 24, baseDir: 180 },
      { nameAr: "قالمة (بوشقوف)", nameFr: "Guelma (Bouchegouf)", lat: 36.46, lng: 7.42, baseSpeed: 29, baseDir: 215 },
    ];

    // Combine station coordinates and active reports
    const activeLocations = [
      ...stations.map(s => ({ lat: s.lat, lng: s.lng, name: isArabic ? s.nameAr : s.nameFr, isStation: true, baseSpeed: s.baseSpeed, baseDir: s.baseDir })),
      ...reports.map(r => ({ lat: r.lat, lng: r.lng, name: r.locationName, isStation: false, baseSpeed: 30, baseDir: 200 })),
      ...satellites.map(s => ({ lat: s.lat, lng: s.lng, name: s.wilaya, isStation: false, baseSpeed: 34, baseDir: 205 }))
    ];

    activeLocations.forEach((loc, idx) => {
      // Determine wind speed and direction (with realistic simulation)
      const speed = loc.baseSpeed + ((idx * 3) % 7) - 3;
      const dir = (loc.baseDir + ((idx * 17) % 20) - 10) % 360;

      // Create custom rotating wind vector Leaflet divIcon
      const windIcon = L.divIcon({
        className: "custom-wind-icon",
        html: `
          <div class="flex items-center gap-1 bg-slate-950/90 border border-indigo-500/40 px-2 py-0.5 rounded-full shadow-lg text-[10px] text-indigo-300 font-bold whitespace-nowrap">
            <span style="display:inline-block; transform: rotate(${dir}deg); transition: transform 0.5s ease;" class="text-indigo-400 font-black">⬆️</span>
            <span>${speed} ${isArabic ? "كم/س" : "km/h"}</span>
          </div>
        `,
        iconSize: [80, 24],
        iconAnchor: [40, 12],
      });

      const windMarker = L.marker([loc.lat, loc.lng], { icon: windIcon, zIndexOffset: -100 }).addTo(windGroup);
      const dirCardinal = dir > 135 && dir < 225 ? (isArabic ? "جنوبي (سيروكو حار)" : "Sirocco Sud") : (isArabic ? "غربي/شمالي" : "Ouest/Nord");
      windMarker.bindTooltip(
        `${isArabic ? "محطة سرعة واتجاه الرياح" : "Station Météo Vent"}: ${loc.name}<br/>` +
        `💨 ${isArabic ? "السرعة" : "Vitesse"}: ${speed} كم/س<br/>` +
        `🧭 ${isArabic ? "الاهتياج والاتجاه" : "Direction"}: ${dir}° (${dirCardinal})`,
        { direction: "top", opacity: 0.95 }
      );

      // If this location is an active fire (report or satellite), draw Wildfire Spread Vectors & Projected Cones!
      if (!loc.isStation) {
        // Convert dir (degrees) to radians
        const rad = ((dir - 90) * Math.PI) / 180;
        const spreadFactor = (speed / 30) * 0.035; // ~3.5km spread scaling

        const dx = Math.cos(rad) * spreadFactor;
        const dy = Math.sin(rad) * spreadFactor;

        // Spread points for 1 hour, 3 hours, 6 hours
        const p1: [number, number] = [loc.lat + dy * 0.4, loc.lng + dx * 0.4];
        const p3: [number, number] = [loc.lat + dy * 0.8, loc.lng + dx * 0.8];
        const p6: [number, number] = [loc.lat + dy * 1.3, loc.lng + dx * 1.3];

        // Draw projected spread line (Polyline)
        L.polyline([[loc.lat, loc.lng], p1, p3, p6], {
          color: "#ef4444",
          weight: 3,
          dashArray: "4, 6",
          opacity: 0.85
        }).addTo(windGroup);

        // Draw spread expansion cone (Polygon) representing risk expansion
        const coneWidth = 0.015;
        const px = -dy * coneWidth;
        const py = dx * coneWidth;

        const conePolygon: [number, number][] = [
          [loc.lat, loc.lng],
          [p6[0] + py, p6[1] + px],
          [p6[0] - py, p6[1] - px]
        ];

        L.polygon(conePolygon, {
          color: "#f97316",
          weight: 1,
          fillColor: "#ef4444",
          fillOpacity: 0.18,
          interactive: true
        }).bindTooltip(
          isArabic 
            ? `⚠️ <b>اتجاه ومسار التوسع المتوقع للنيران (حسب الرياح)</b><br/>معدل التمدد: ~${(speed * 0.12).toFixed(1)} كم/ساعة نحو ${dirCardinal}`
            : `⚠️ <b>Trajectoire de propagation estimée du feu</b><br/>Vitesse d'expansion: ~${(speed * 0.12).toFixed(1)} km/h vers le ${dirCardinal}`,
          { direction: "center", permanent: false }
        ).addTo(windGroup);
      }
    });

  }, [showWindOverlay, reports, satellites, isArabic]);

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !userLocation) return;

    // Center map on user location if not already centered
    if (!hasCenteredRef.current) {
      map.setView([userLocation.lat, userLocation.lng], 11, { animate: true });
      hasCenteredRef.current = true;
    }
  }, [userLocation]);

  return (
    <div className="relative w-full h-[480px] sm:h-[520px] md:h-[580px] bg-slate-900 rounded-xl overflow-hidden shadow-2xl border border-slate-800 flex flex-col">
      <div
        id="map-target"
        ref={mapContainerRef}
        className="w-full h-full relative z-0"
        style={{ height: "100%", minHeight: "450px" }}
      />

      {/* Absolute overlay indicator and Map Style Selector */}
      <div className="absolute top-3 right-3 z-[1000] bg-slate-950/95 border border-slate-800 backdrop-blur text-xs py-1.5 px-3 rounded-lg shadow-lg flex items-center gap-3 flex-wrap">
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

        {/* Wind & Spread Layer Toggle Button */}
        <div className="w-px h-3 bg-slate-800"></div>
        <button
          type="button"
          onClick={() => setShowWindOverlay(!showWindOverlay)}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer border ${
            showWindOverlay 
              ? "bg-indigo-950/80 border-indigo-500/60 text-indigo-300 shadow-sm shadow-indigo-500/20" 
              : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
          }`}
          title={isArabic ? "تفعيل طبقة اتجاه الرياح ومسار انتشار النيران" : "Activer la couche du vent et de propagation"}
        >
          <span>💨</span>
          <span>{isArabic ? "الرياح وانتشار النار" : "Vent & Propagation"}</span>
          <span className={`w-1.5 h-1.5 rounded-full ${showWindOverlay ? "bg-indigo-400 animate-pulse" : "bg-gray-600"}`}></span>
        </button>

        {/* Tile Layer Selector */}
        <div className="w-px h-3 bg-slate-800"></div>
        <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded border border-slate-800">
          <button
            type="button"
            onClick={() => setTileStyle("dark")}
            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
              tileStyle === "dark" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {isArabic ? "داكنة" : "Sombre"}
          </button>
          <button
            type="button"
            onClick={() => setTileStyle("osm")}
            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
              tileStyle === "osm" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {isArabic ? "عادية" : "Standard"}
          </button>
          <button
            type="button"
            onClick={() => setTileStyle("satellite")}
            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
              tileStyle === "satellite" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {isArabic ? "فضائية" : "Satellite"}
          </button>
        </div>
      </div>

      <div className="absolute bottom-3 left-3 z-[1000] bg-slate-950/90 text-[10px] text-slate-400 px-2.5 py-1 rounded border border-slate-800 backdrop-blur">
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

// Helper to get offset for dispatch teams
function getTeamStartOffset(teamNameFr: string) {
  if (teamNameFr.includes("1") || teamNameFr.includes("Bordj")) return { dLat: 0.025, dLng: -0.03 };
  if (teamNameFr.includes("Soutien") || teamNameFr.includes("SOUTIEN") || teamNameFr.includes("2")) return { dLat: 0.035, dLng: 0.02 };
  if (teamNameFr.includes("MONTAGNE") || teamNameFr.includes("Mobile") || teamNameFr.includes("3")) return { dLat: -0.02, dLng: -0.035 };
  if (teamNameFr.includes("Secouristes") || teamNameFr.includes("CRA") || teamNameFr.includes("Crescent")) return { dLat: -0.03, dLng: 0.025 };
  if (teamNameFr.includes("Volontaires") || teamNameFr.includes("Assoc")) return { dLat: 0.015, dLng: -0.035 };
  if (teamNameFr.includes("MOTO")) return { dLat: -0.025, dLng: 0.03 };
  return { dLat: 0.022, dLng: -0.022 }; // default
}

function createVehiclePopupContent(team: any, progress: number, remainingMin: number, isArabic: boolean) {
  const isPC = team.type === "protection_civile";
  const title = isArabic ? (isPC ? "شاحنة نجدة (الحماية المدنية)" : "مركبة دعم (متطوعين)") : (isPC ? "Camion PC" : "Véhicule Volontaire");
  const name = isArabic ? team.teamNameAr : team.teamNameFr;
  const statusText = progress >= 1 
    ? (isArabic ? "وصلت للموقع وهي تقوم بالإنقاذ الآن 🚒" : "Arrivée sur les lieux 🚒")
    : (isArabic ? `في الطريق (الوصول بعد حوالي ${remainingMin} د)` : `En route (ETA: ~${remainingMin} min)`);
  
  return `
    <div class="p-2 text-slate-100 font-sans" dir="${isArabic ? "rtl" : "ltr"}">
      <div class="flex items-center gap-2 mb-1.5 bg-slate-800 p-1 rounded border border-slate-700">
        <span class="text-base">${isPC ? "🚒" : "💚"}</span>
        <strong class="text-xs font-bold text-amber-400">${title}</strong>
      </div>
      <div class="space-y-1 text-xs text-slate-300">
        <p><strong>${isArabic ? "الفرقة:" : "Équipe:"}</strong> ${name}</p>
        <p><strong>${isArabic ? "الحالة:" : "Statut:"}</strong> ${statusText}</p>
        <p><strong>${isArabic ? "السرعة:" : "Vitesse:"}</strong> ${progress >= 1 ? "0" : "55"} كم/س</p>
        ${team.notes ? `<p><strong>${isArabic ? "ملاحظات:" : "Notes:"}</strong> ${team.notes}</p>` : ""}
      </div>
    </div>
  `;
}
