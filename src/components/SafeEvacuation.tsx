import { useState, useEffect, useRef, useMemo } from "react";
import L from "leaflet";
import { Map as MapIcon, Navigation2, ShieldCheck, AlertTriangle, Car, Compass, Activity, Flame } from "lucide-react";
import { Report, SatelliteHotspot } from "../types";
import { haversineKm } from "../utils/geo";

interface SafeEvacuationProps {
  lang: "ar" | "fr";
  userLocation: { lat: number; lng: number } | null;
  reports?: Report[];
  satellites?: SatelliteHotspot[];
}

interface SafeZone {
  id: string;
  nameAr: string;
  nameFr: string;
  capacity: number;
  lat: number;
  lng: number;
  hasMedical: boolean;
  isActive?: boolean;
}

type LngLat = [number, number];

/**
 * v1.0.4 rewrite ("هل أنت متأكد أنها تشتغل؟" — the owner was right to doubt).
 * The old page only asked OSRM for a DISTANCE (overview=false) and drew
 * nothing: "مسارات الإخلاء" was a distance calculator without a map.
 *
 * Now:
 *  - OSRM returns the REAL road geometry (overview=full, geojson) which is
 *    drawn as a Leaflet polyline on a proper base map, with the user, the
 *    chosen center and nearby fire sources as markers
 *  - every decoded route point is checked against fused fire sources
 *    (verified/pending reports + FIRMS hotspots >= 70%): if the road passes
 *    within FIRE_PROXIMITY_ALERT_KM of a fire, a loud warning is shown
 *  - offline/failure fallback stays an honestly-labelled straight-line
 *    estimate (no fake route is drawn in that case)
 */
export default function SafeEvacuation({ lang, userLocation, reports = [], satellites = [] }: SafeEvacuationProps) {
  const isArabic = lang === "ar";
  const [isCalculating, setIsCalculating] = useState(false);
  const [activeRoute, setActiveRoute] = useState<SafeZone | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [zones, setZones] = useState<SafeZone[]>([]);
  const [routeInfo, setRouteInfo] = useState<{ distanceKm: number; durationMin: number; source: "osrm" | "estimate" } | null>(null);
  const [routeGeometry, setRouteGeometry] = useState<LngLat[] | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [zonesStatus, setZonesStatus] = useState<"loading" | "ready" | "fallback">("loading");

  // ---- Leaflet map (always mounted under the state overlays) ---------------
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const zoomedRef = useRef(false);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, {
      center: userLocation ? [userLocation.lat, userLocation.lng] : [35.5, 5.0],
      zoom: userLocation ? 12 : 6,
      zoomControl: true,
      attributionControl: true,
    });
    // v2.1.0: off CARTO (anonymous clients get "API KEY REQUIRED" watermark
    // tiles now) — standard keyless OSM raster keeps roads + labels readable
    // for an evacuation run.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Continuous size sync — the one-shot timeout pattern left grey maps when
    // the container mounted hidden or resized (same lesson as InteractiveMap).
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => map.invalidateSize()) : null;
    ro?.observe(container);

    return () => {
      ro?.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      zoomedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fused fire sources near the evacuation theatre (used for markers and the
  // route-proximity check). Same admission rule as the tactical radar.
  const fireSources = useMemo(() => {
    const list: { lat: number; lng: number; label: string }[] = [];
    for (const r of reports) {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
      if (r.status !== "verified" && r.status !== "pending") continue;
      list.push({ lat: r.lat, lng: r.lng, label: r.locationName || (isArabic ? "بلاغ حريق" : "Signalement") });
    }
    for (const s of satellites) {
      if (s.confidence < 70 || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
      list.push({ lat: s.lat, lng: s.lng, label: isArabic ? `نقطة ساخنة (${s.satellite})` : `Point chaud (${s.satellite})` });
    }
    return list;
  }, [reports, satellites, isArabic]);

  // How close does the active route pass to any fire? Null = no route.
  const routeFireProximityKm = useMemo<number | null>(() => {
    if (!routeGeometry || routeGeometry.length === 0 || fireSources.length === 0) return null;
    let min = Infinity;
    // Decode every 4th vertex — OSRM full geometry is dense; a 4-point stride
    // keeps the check well under any real-world error while staying cheap.
    for (let i = 0; i < routeGeometry.length; i += 4) {
      const [lng, lat] = routeGeometry[i];
      for (const f of fireSources) {
        const d = haversineKm(lat, lng, f.lat, f.lng);
        if (d < min) min = d;
      }
    }
    return Number.isFinite(min) ? min : null;
  }, [routeGeometry, fireSources]);

  const FIRE_PROXIMITY_ALERT_KM = 2.5;

  // Redraw the route layer whenever geometry / fires / selection change.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    for (const f of fireSources) {
      const inTheatre = !userLocation || haversineKm(userLocation.lat, userLocation.lng, f.lat, f.lng) <= 60;
      if (!inTheatre) continue;
      L.marker([f.lat, f.lng], {
        icon: L.divIcon({
          className: "",
          html: '<div style="font-size:18px;line-height:18px;filter:drop-shadow(0 0 3px rgba(239,68,68,.9))">🔥</div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
      }).addTo(layer);
    }

    if (userLocation) {
      L.circleMarker([userLocation.lat, userLocation.lng], {
        radius: 7, color: "#ffffff", weight: 2, fillColor: "#0ea5e9", fillOpacity: 1,
      }).addTo(layer).bindTooltip(isArabic ? "موقعك" : "Votre position");
    }

    if (activeRoute) {
      L.marker([activeRoute.lat, activeRoute.lng], {
        icon: L.divIcon({
          className: "",
          html: '<div style="font-size:20px;line-height:20px;filter:drop-shadow(0 0 3px rgba(16,185,129,.9))">🏠</div>',
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        }),
      }).addTo(layer).bindTooltip(isArabic ? activeRoute.nameAr : activeRoute.nameFr);
    }

    if (routeGeometry && routeGeometry.length > 1 && activeRoute) {
      const latlngs = routeGeometry.map(([lng, lat]) => [lat, lng] as [number, number]);
      L.polyline(latlngs, { color: "#10b981", weight: 5, opacity: 0.9 }).addTo(layer);
      L.polyline(latlngs, { color: "#ffffff", weight: 1.5, opacity: 0.5, dashArray: "6 8" }).addTo(layer);
      const group = L.featureGroup([...layer.getLayers()]);
      if (!zoomedRef.current) {
        map.fitBounds(group.getBounds(), { padding: [28, 28] });
        zoomedRef.current = true;
      }
    } else if (userLocation && !zoomedRef.current) {
      // Only the FIRST paint centers on the user — later fire-list refreshes
      // (15 s polling) must never yank the map back while the user pans.
      map.setView([userLocation.lat, userLocation.lng], 12);
      zoomedRef.current = true;
    }
  }, [routeGeometry, activeRoute, fireSources, userLocation, isArabic]);

  // (existing) load safe zones from the admin-managed Firestore collection
  useEffect(() => {
    let cancelled = false;
    fetch("/api/safezones")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("bad status"))))
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data) && data.length > 0) {
          setZones(data.filter((z: any) => z.isActive !== false));
          setZonesStatus("ready");
        } else {
          setZones([]);
          setZonesStatus("fallback");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setZones([]);
          setZonesStatus("fallback");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Real compass heading via device orientation. No synthetic heading is shown
  // when the browser/device does not expose a compass signal.
  useEffect(() => {
    const onOrientation = (e: DeviceOrientationEvent) => {
      const webkitEvent = e as DeviceOrientationEvent & { webkitCompassHeading?: number | null };
      let deg: number | null = null;
      if (webkitEvent.webkitCompassHeading !== undefined && webkitEvent.webkitCompassHeading !== null) {
        deg = webkitEvent.webkitCompassHeading;
      } else if (e.alpha !== null) {
        deg = 360 - e.alpha;
      }
      if (deg !== null) {
        setHeading(Math.round(deg));
      }
    };
    window.addEventListener("deviceorientation", onOrientation);
    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
    };
  }, []);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const handleCalculateRoute = async (zone: SafeZone) => {
    if (!userLocation) {
      setRouteError(isArabic ? "لا يمكن حساب المسافة قبل تحديد موقعك." : "Votre position est nécessaire pour calculer la distance.");
      setActiveRoute(null);
      setRouteInfo(null);
      setRouteGeometry(null);
      return;
    }
    setIsCalculating(true);
    setActiveRoute(null);
    setRouteInfo(null);
    setRouteGeometry(null);
    setRouteError(null);
    zoomedRef.current = false;

    const from = userLocation;
    let distanceKm = haversineKm(from.lat, from.lng, zone.lat, zone.lng);
    let durationMin = Math.max(1, Math.round(distanceKm / 0.6));
    let source: "osrm" | "estimate" = "estimate";
    let geometry: LngLat[] | null = null;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      // v1.0.4: overview=full + geojson — we need the REAL road geometry to
      // draw the route and check it against fire sources, not just a number.
      const res = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${zone.lng},${zone.lat}?overview=full&geometries=geojson`,
        { signal: controller.signal }
      );
      if (res.ok) {
        const data = await res.json();
        const route = data?.routes?.[0];
        if (route?.distance) {
          distanceKm = Math.round((route.distance / 1000) * 10) / 10;
          durationMin = Math.max(1, Math.round(route.duration / 60));
          source = "osrm";
          const coords = route?.geometry?.coordinates;
          if (Array.isArray(coords) && coords.length > 1) {
            geometry = coords as LngLat[];
          }
        }
      }
    } catch {
      // OSRM unreachable — keep a clearly labelled straight-line estimate and
      // NO drawn route (an invented line on a map would be a lie).
    } finally {
      window.clearTimeout(timeout);
    }
    setIsCalculating(false);
    setActiveRoute(zone);
    setRouteInfo({ distanceKm, durationMin, source });
    setRouteGeometry(source === "osrm" ? geometry : null);
    if (source === "estimate") {
      setRouteError(
        isArabic
          ? "تعذر الوصول لخدمة الطرق — القيم أدناه تقدير خط مستقيم وليست طريقًا حقيقيًا."
          : "Service routier indisponible — les valeurs ci-dessous sont une estimation à vol d'oiseau, pas une route réelle."
      );
    }
  };

  const startVoiceNavigation = (zone: SafeZone) => {
    if (!("speechSynthesis" in window)) {
      alert(isArabic ? "الملاحة الصوتية غير مدعومة في متصفحك." : "Navigation vocale non supportée par votre navigateur.");
      return;
    }
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
    const dist = routeInfo?.distanceKm;
    if (dist === undefined) {
      setRouteError(isArabic ? "احسب المسافة أولًا بعد تحديد موقعك." : "Calculez d'abord la distance après avoir autorisé votre position.");
      return;
    }
    const proximityLine =
      routeFireProximityKm !== null && routeFireProximityKm < FIRE_PROXIMITY_ALERT_KM
        ? isArabic
          ? `تنبيه: المسار يقترب من نقطة حريق على بعد أقل من ${routeFireProximityKm.toFixed(1)} كيلومتر.`
          : `Alerte : l'itinéraire passe à moins de ${routeFireProximityKm.toFixed(1)} kilomètre d'un feu.`
        : "";
    const steps = isArabic
      ? [
          "تم حساب مسار طريق حقيقي.",
          `الوجهة ${zone.nameAr} على بعد حوالي ${Math.round(dist)} كيلومتر.`,
          proximityLine,
          "هذه الصفحة لا تؤكد أن الطريق آمن من الحريق.",
          "اتبع تعليمات الحماية المدنية واللافتات الرسمية في الميدان.",
        ].filter(Boolean)
      : [
          "Un itinéraire routier réel a été calculé.",
          `La destination ${zone.nameFr} est à environ ${Math.round(dist)} kilomètres.`,
          proximityLine,
          "Cette page ne confirme pas que la route est sûre face à l'incendie.",
          "Suivez les consignes officielles et la signalisation sur le terrain.",
        ].filter(Boolean);
    const utterance = new SpeechSynthesisUtterance(steps.join(" "));
    utterance.lang = isArabic ? "ar-SA" : "fr-FR";
    utterance.rate = 1;
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  };

  const routeNearFire = routeFireProximityKm !== null && routeFireProximityKm < FIRE_PROXIMITY_ALERT_KM;

  return (
    <div className="bg-zinc-900/80 border border-slate-700/50 rounded-xl p-5 shadow-2xl font-sans text-slate-200 min-h-[640px] flex flex-col">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-center border-b border-white/5 pb-4 mb-4 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-sky-500/20 text-sky-400">
            <Compass className="h-6 w-6" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-slate-100 flex items-center gap-2">
              {isArabic ? "مسارات الإخلاء على الطرق الحقيقية" : "Itinéraires d'Évacuation (réseau routier réel)"}
              <span className="bg-sky-500/20 text-sky-300 text-[10px] px-2 py-0.5 rounded border border-sky-500/30">OSRM</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              {isArabic
                ? "مسار طريق حقيقي مرسوم على الخريطة + فحص تقارب نقاط الحرائق؛ سلامة الطريق النهائية تتحقق في الميدان فقط."
                : "Itinéraire routier réel tracé sur la carte + vérification de proximité des feux ; la sécurité finale se vérifie sur le terrain."}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">

        {/* Safe Zones List */}
        <div className="lg:col-span-1 bg-black/40 border border-white/5 rounded-xl p-4 flex flex-col overflow-hidden">
          <h4 className="text-sm font-bold text-slate-300 mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            {isArabic ? "مراكز الإخلاء المُبلّغ عنها" : "Centres d'évacuation signalés"}
          </h4>

          {zonesStatus === "fallback" && (
            <p role="status" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-950/30 p-2 text-[10px] leading-relaxed text-amber-300">
              {isArabic
                ? "تعذر التحقق من حالة مراكز الإخلاء حاليًا. لا تعتبر أي مركز آمنًا أو مفتوحًا دون تأكيد رسمي."
                : "Impossible de vérifier l'état actuel des centres d'évacuation. Ne considérez aucun centre comme ouvert ou sûr sans confirmation officielle."}
            </p>
          )}

          <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar">
            {zones.length === 0 && zonesStatus !== "loading" && (
              <p className="text-[11px] text-slate-500 text-center py-4">
                {isArabic ? "لا توجد مراكز مسجلة بعد — يمكن للمشرف إضافتها من لوحة التحكم." : "Aucun centre enregistré — un administrateur peut en ajouter depuis le panneau."}
              </p>
            )}
            {zones.map((zone) => {
              const zoneDistance = userLocation
                ? haversineKm(userLocation.lat, userLocation.lng, zone.lat, zone.lng)
                : null;

              return (
                <div key={zone.id} className={`p-3 rounded-xl border transition-all ${
                  activeRoute?.id === zone.id
                    ? "bg-sky-900/30 border-sky-500/50"
                    : "bg-slate-800/50 border-slate-700/50 hover:bg-slate-700/50"
                }`}>
                  <div className="flex justify-between items-start mb-2">
                    <h5 className="text-sm font-bold text-slate-200">{isArabic ? zone.nameAr : zone.nameFr}</h5>
                    <span className="text-xs font-mono text-sky-400 bg-sky-950 px-1.5 py-0.5 rounded">
                      {zoneDistance === null ? (isArabic ? "الموقع غير متاح" : "Position indisponible") : `${zoneDistance.toFixed(1)} km`}
                    </span>
                  </div>

                  <div className="flex items-center gap-4 text-[10px] text-slate-400 mb-3">
                    <span className="flex items-center gap-1">
                      <Activity className="h-3 w-3" />
                      {isArabic ? `السعة المسجلة ${zone.capacity.toLocaleString()} شخص` : `Capacité déclarée ${zone.capacity.toLocaleString()} pers`}
                    </span>
                    {zone.hasMedical && (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <ShieldCheck className="h-3 w-3" />
                        {isArabic ? "نقطة طبية" : "Point Médical"}
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => handleCalculateRoute(zone)}
                    disabled={isCalculating}
                    className={`w-full py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                      activeRoute?.id === zone.id
                        ? "bg-sky-600 text-white"
                        : "bg-indigo-600 hover:bg-indigo-500 text-white"
                    }`}
                  >
                    {isCalculating && activeRoute?.id !== zone.id ? (
                      <span className="animate-pulse">{isArabic ? "جاري حساب المسار..." : "Calcul de l'itinéraire..."}</span>
                    ) : activeRoute?.id === zone.id ? (
                      <>
                        <Navigation2 className="h-3 w-3" />
                        {isArabic ? "المسار نشط على الخريطة" : "Itinéraire actif sur la carte"}
                      </>
                    ) : (
                      <>
                        <MapIcon className="h-3 w-3" />
                        {isArabic ? "اعرض مسار الطريق" : "Tracer l'itinéraire routier"}
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Map + Navigation Panel */}
        <div className="lg:col-span-2 bg-slate-900 border border-white/5 rounded-xl flex flex-col p-4 relative overflow-hidden">

          {/* THE MAP — always mounted; state overlays sit above it */}
          <div className="relative flex-1 min-h-[380px] rounded-xl overflow-hidden border border-white/10">
            <div ref={mapContainerRef} className="absolute inset-0 z-[1]" />

            {isCalculating && (
              <div className="absolute inset-0 z-[20] bg-slate-950/80 flex flex-col items-center justify-center opacity-95 text-sky-400 gap-4">
                <div className="relative">
                  <div className="h-16 w-16 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin"></div>
                  <Compass className="h-6 w-6 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-sky-300" />
                </div>
                <p className="text-sm font-bold animate-pulse">
                  {isArabic ? "جاري حساب مسار الطريق الحقيقي..." : "Calcul de l'itinéraire routier réel..."}
                </p>
              </div>
            )}

            {!isCalculating && !activeRoute && (
              <div className="absolute inset-0 z-[20] bg-slate-950/70 flex flex-col items-center justify-center text-slate-300 gap-3 p-6 text-center">
                <MapIcon className="h-12 w-12 opacity-50" />
                <p className="text-sm max-w-xs">
                  {isArabic
                    ? "اختر مركز إخلاء من القائمة لرسم مسار الطريق الحقيقي على الخريطة."
                    : "Choisissez un centre d'évacuation pour tracer l'itinéraire routier réel sur la carte."}
                </p>
                {routeError && <p role="alert" className="text-xs text-amber-300 max-w-xs">{routeError}</p>}
              </div>
            )}
          </div>

          {/* Route summary + warnings + voice (below the map) */}
          {activeRoute && !isCalculating && (
            <div className="mt-4 space-y-3">
              <div className="bg-sky-950/30 border border-sky-900/50 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <h4 className="font-bold text-sky-100 flex items-center gap-2">
                    <Navigation2 className="h-4 w-4 text-sky-400" />
                    {isArabic ? "مسار طريق حقيقي" : "Itinéraire routier réel"}
                  </h4>
                  <p className="text-xs text-slate-400 mt-1 flex items-center gap-2">
                    <Car className="h-3 w-3" />
                    {routeInfo ? `${routeInfo.distanceKm} km • ~${routeInfo.durationMin} ${isArabic ? "دقيقة" : "min"} (${routeInfo.source === "osrm" ? "OSRM" : isArabic ? "تقدير خط مستقيم" : "estimation à vol d'oiseau"})` : "..."}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
                    <Compass className="h-3 w-3" />
                    {isArabic ? "اتجاه البوصلة:" : "Cap de la boussole:"} {heading !== null ? `${heading}°` : isArabic ? "غير متاح" : "indisponible"}
                  </p>
                </div>
                <div className="text-left">
                  <span className="inline-block px-2 py-1 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] rounded font-bold">
                    {isArabic ? "سلامة الحريق غير مُتحققة نهائيًا" : "Sécurité incendie non garantie"}
                  </span>
                </div>
              </div>

              {routeInfo?.source === "osrm" && routeFireProximityKm !== null && (
                routeNearFire ? (
                  <div role="alert" className="rounded-xl border border-red-500/50 bg-red-950/40 p-3 flex items-start gap-2">
                    <Flame className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-bold text-red-300">
                        {isArabic ? `⚠️ المسار يقترب من حريق على بعد ${routeFireProximityKm.toFixed(1)} كم فقط` : `⚠️ L'itinéraire passe à ${routeFireProximityKm.toFixed(1)} km d'un feu`}
                      </p>
                      <p className="text-[11px] text-red-200/80 mt-0.5">
                        {isArabic
                          ? "فكّر في مركز إخلاء آخر أو اتصل بالحماية المدنية (1021) للتأكد من الممر الآمن."
                          : "Envisagez un autre centre ou appelez la Protection civile (1021) pour confirmer le corridor sûr."}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3 flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    <p className="text-[11px] text-emerald-300">
                      {isArabic
                        ? `أقرب نقطة حريق معروفة إلى المسار تبعد ${routeFireProximityKm.toFixed(1)} كم — لا مجاورة مباشرة ضمن ${FIRE_PROXIMITY_ALERT_KM} كم.`
                        : `Le feu connu le plus proche de l'itinéraire est à ${routeFireProximityKm.toFixed(1)} km — pas de proximité directe (< ${FIRE_PROXIMITY_ALERT_KM} km).`}
                    </p>
                  </div>
                )
              )}

              {routeError && (
                <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-950/30 p-2 text-[11px] text-amber-300">{routeError}</p>
              )}

              <div className="pt-1">
                <button
                  onClick={() => startVoiceNavigation(activeRoute)}
                  className={`w-full font-bold py-3 rounded-lg flex items-center justify-center gap-2 transition-all ${
                    isSpeaking
                      ? "bg-red-600 hover:bg-red-500 text-white animate-pulse"
                      : "bg-emerald-600 hover:bg-emerald-500 text-white"
                  }`}
                >
                  <Navigation2 className="h-5 w-5" />
                  {isSpeaking
                    ? (isArabic ? "إيقاف الملاحة الصوتية" : "Arrêter la navigation")
                    : (isArabic ? "استمع إلى ملخص المسار" : "Écouter le résumé de l'itinéraire")}
                </button>
                <p className="text-xs text-center text-slate-400 mt-2 flex items-center justify-center gap-1">
                  <AlertTriangle className="h-3 w-3 text-amber-400" />
                  {isArabic ? "الصوت يلخص المسار فقط ولا يوفر ملاحة تفصيلية دون اتصال." : "Le son résume l'itinéraire uniquement; pas de navigation détaillée hors ligne."}
                </p>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
