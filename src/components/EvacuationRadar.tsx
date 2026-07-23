import { useState, useEffect, useRef } from "react";
import L from "leaflet";
import { Compass, Wind, AlertTriangle, ShieldCheck, HelpCircle, Navigation, Radio, Copy, Check } from "lucide-react";
import { Report, SatelliteHotspot } from "../types";

interface EvacuationRadarProps {
  reports: Report[];
  satellites?: SatelliteHotspot[];
  userLocation: { lat: number; lng: number } | null;
  lang: "ar" | "fr";
}

type NavTileStyle = "osm" | "satellite" | "dark";

export default function EvacuationRadar({ reports, satellites = [], userLocation, lang }: EvacuationRadarProps) {
  const isArabic = lang === "ar";
  const activeLoc = userLocation || { lat: 36.72, lng: 5.08 };
  
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const layersGroupRef = useRef<L.LayerGroup | null>(null);
  const [navTileStyle, setNavTileStyle] = useState<NavTileStyle>("osm");
  const [showRadioGuide, setShowRadioGuide] = useState(false);
  const [copiedFreq, setCopiedFreq] = useState<string | null>(null);
  const [routeCoords, setRouteCoords] = useState<[number, number][] | null>(null);
  const [evacRouteMeta, setEvacRouteMeta] = useState<{ distance: number; duration: number } | null>(null);

  // Dynamic meteorological wind vector for North Africa with live Open-Meteo API fetching
  const [wind, setWind] = useState({
    direction: 260, // degrees (West-South-West)
    speed: 38, // km/h
    temperature: 41, // °C
    isLive: false,
  });

  const [radarRange, setRadarRange] = useState<15 | 30 | 50 | 100>(30);

  // Fetch real-time weather & wind vectors for active location
  useEffect(() => {
    let isMounted = true;
    const fetchLiveWind = async () => {
      try {
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${activeLoc.lat}&longitude=${activeLoc.lng}&current_weather=true`
        );
        if (res.ok) {
          const data = await res.json();
          if (data.current_weather && isMounted) {
            setWind({
              direction: Math.round(data.current_weather.winddirection || 260),
              speed: Math.round(data.current_weather.windspeed || 35),
              temperature: Math.round(data.current_weather.temperature || 38),
              isLive: true,
            });
          }
        }
      } catch (e) {
        console.warn("Open-Meteo wind API offline, using regional weather model fallback", e);
      }
    };

    fetchLiveWind();
    return () => {
      isMounted = false;
    };
  }, [activeLoc.lat, activeLoc.lng]);

  // Compute Haversine distance in km
  const getDistance = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const R = 6371;
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

  // Compute bearing angle between two coords (0-360)
  const getBearing = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const lat1Rad = (lat1 * Math.PI) / 180;
    const lat2Rad = (lat2 * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x =
      Math.cos(lat1Rad) * Math.sin(lat2Rad) -
      Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    let bearing = (Math.atan2(y, x) * 180) / Math.PI;
    return (bearing + 360) % 360;
  };

  const getDirectionName = (angle: number) => {
    const directions = isArabic
      ? ["الشمال 🧭", "الشمال الشرقي ↗️", "الشرق ➡️", "الجنوب الشرقي ↘️", "الجنوب ⬇️", "الجنوب الغربي ↙️", "الغرب ⬅️", "الشمال الغربي ↖️"]
      : ["Nord 🧭", "Nord-Est ↗️", "Est ➡️", "Sud-Est ↘️", "Sud ⬇️", "Sud-Ouest ↙️", "Ouest ⬅️", "Nord-Ouest ↖️"];
    const index = Math.round(((angle % 360) / 45)) % 8;
    return directions[index];
  };

  const getBearingDirection = (angle: number) => {
    const directions = isArabic
      ? ["شمال", "شمال شرقي", "شرق", "جنوب شرقي", "جنوب", "جنوب غربي", "غرب", "شمال غربي"]
      : ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
    const index = Math.round(((angle % 360) / 45)) % 8;
    return directions[index];
  };

  // Combine citizen reports AND NASA FIRMS satellite hotspots into unified hazard list
  const allHazards = [
    ...reports.map((r) => ({
      id: r.id,
      lat: r.lat,
      lng: r.lng,
      locationName: r.locationName,
      description: r.description,
      severity: r.severity || "high",
      type: "report" as const,
    })),
    ...satellites.map((s) => ({
      id: `sat_${s.id}`,
      lat: s.lat,
      lng: s.lng,
      locationName: `رصد قمر صناعي NASA (${s.wilaya})`,
      description: `بؤرة حرارية فلكية NASA FIRMS (سطوع: ${s.brightness}K، دقة: ${s.confidence}%)`,
      severity: (s.confidence > 80 ? "critical" : "high") as any,
      type: "satellite" as const,
    })),
  ];

  // Mediterranean Sea boundary detection for Northern Algeria
  const isPointInMediterraneanSea = (lat: number, lng: number): boolean => {
    if (lng >= 0.0 && lng <= 8.8) {
      if (lng >= 4.5 && lng <= 6.2 && lat > 36.75) return true; // Béjaïa & Jijel coast
      if (lng >= 2.8 && lng < 4.5 && lat > 36.78) return true;  // Algiers & Boumerdes coast
      if (lng >= 6.2 && lng <= 8.8 && lat > 36.88) return true;  // Skikda & El Tarf coast
      if (lat > 36.82) return true; // General northern coastline cutoff
    }
    return false;
  };

  // Calculate distances to ALL hazards (reports + satellites)
  const hazardsWithDistance = allHazards
    .map((h) => {
      const dist = getDistance(activeLoc.lat, activeLoc.lng, h.lat, h.lng);
      const bearing = getBearing(activeLoc.lat, activeLoc.lng, h.lat, h.lng);
      return { ...h, distance: dist, bearing };
    })
    .sort((a, b) => a.distance - b.distance);

  const closestFire = hazardsWithDistance[0];

  // Land-Safe Evacuation Vector Calculation (Sea & Multi-Hazard Avoidance)
  let safeHeading = 180; // Default South inland
  let isSeaAdjusted = false;

  if (closestFire) {
    const rawReverse = (closestFire.bearing + 180) % 360;

    const candidateAngles = [
      rawReverse,
      (rawReverse + 30) % 360,
      (rawReverse - 30 + 360) % 360,
      (rawReverse + 60) % 360,
      (rawReverse - 60 + 360) % 360,
      (rawReverse + 90) % 360,
      (rawReverse - 90 + 360) % 360,
      180, // South inland
      225, // SW inland
      135, // SE inland
      270, // West
      90,  // East
    ];

    let bestAngle = rawReverse;
    let maxScore = -Infinity;

    candidateAngles.forEach((angle) => {
      const distKm = 15;
      const rad = (angle * Math.PI) / 180;
      const testLat = activeLoc.lat + (distKm / 111) * Math.cos(rad);
      const testLng = activeLoc.lng + (distKm / (111 * Math.cos((activeLoc.lat * Math.PI) / 180))) * Math.sin(rad);

      // Skip sea points!
      if (isPointInMediterraneanSea(testLat, testLng)) return;

      // Min distance to all fires
      let minDistToFires = Infinity;
      hazardsWithDistance.forEach((h) => {
        const d = getDistance(testLat, testLng, h.lat, h.lng);
        if (d < minDistToFires) minDistToFires = d;
      });

      // Bonus for moving inland Southward when near northern coast
      const inlandBonus = activeLoc.lat > 36.5 ? (37.0 - testLat) * 20 : 0;
      const score = minDistToFires * 3 + inlandBonus;

      if (score > maxScore) {
        maxScore = score;
        bestAngle = angle;
      }
    });

    if (Math.abs(bestAngle - rawReverse) > 15 || isPointInMediterraneanSea(
      activeLoc.lat + (15 / 111) * Math.cos((rawReverse * Math.PI) / 180),
      activeLoc.lng + (15 / (111 * Math.cos((activeLoc.lat * Math.PI) / 180))) * Math.sin((rawReverse * Math.PI) / 180)
    )) {
      isSeaAdjusted = true;
    }

    safeHeading = bestAngle;
  }

  const driftHeading = (wind.direction + 180) % 360; // Spread direction

  // Fetch OSRM Evacuation Route
  useEffect(() => {
    if (!closestFire || closestFire.distance > 15) {
      setRouteCoords(null);
      setEvacRouteMeta(null);
      return;
    }

    const safeDistanceKm = Math.min(15, Math.max(5, closestFire.distance * 1.5));
    const safeRad = (safeHeading * Math.PI) / 180;
    const dLat = (safeDistanceKm / 111) * Math.cos(safeRad);
    const dLng = (safeDistanceKm / (111 * Math.cos((activeLoc.lat * Math.PI) / 180))) * Math.sin(safeRad);

    const safeTargetLat = activeLoc.lat + dLat;
    const safeTargetLng = activeLoc.lng + dLng;

    let isMounted = true;
    const fetchRoute = async () => {
      try {
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${activeLoc.lng},${activeLoc.lat};${safeTargetLng},${safeTargetLat}?overview=full&geometries=geojson`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            const coords = route.geometry.coordinates.map((c: number[]) => [c[1], c[0]]);
            setRouteCoords(coords);
            setEvacRouteMeta({
              distance: route.distance / 1000,
              duration: route.duration / 60,
            });
          }
        }
      } catch (err) {
        console.error("OSRM Route fetching failed", err);
      }
    };

    fetchRoute();
    return () => { isMounted = false; };
  }, [activeLoc.lat, activeLoc.lng, closestFire?.distance, safeHeading]);

  // Helper tile layer getters
  const getNavTileUrl = (style: NavTileStyle) => {
    switch (style) {
      case "satellite":
        return "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
      case "dark":
        return "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
      case "osm":
      default:
        return "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    }
  };

  // Switch tile layer
  useEffect(() => {
    if (!mapRef.current) return;
    if (tileLayerRef.current) {
      mapRef.current.removeLayer(tileLayerRef.current);
    }
    const newLayer = L.tileLayer(getNavTileUrl(navTileStyle), {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap / Esri',
    });
    newLayer.addTo(mapRef.current);
    tileLayerRef.current = newLayer;
  }, [navTileStyle]);

  // Initial map setup
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [activeLoc.lat, activeLoc.lng],
      zoom: 10,
      zoomControl: false,
      preferCanvas: true,
    });

    const tileLayer = L.tileLayer(getNavTileUrl("osm"), {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap',
    });
    tileLayer.addTo(map);
    tileLayerRef.current = tileLayer;

    // Custom zoom control in top left
    L.control.zoom({ position: "topleft" }).addTo(map);

    layersGroupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    map.invalidateSize();
    const t1 = setTimeout(() => map.invalidateSize(), 200);
    const t2 = setTimeout(() => map.invalidateSize(), 600);

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
    };
  }, []);

  // Update center & map features
  useEffect(() => {
    const map = mapRef.current;
    const group = layersGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();
    map.setView([activeLoc.lat, activeLoc.lng], map.getZoom());

    // 1. Draw User GPS Location Marker (Pulsing blue navigation beacon)
    const userIcon = L.divIcon({
      className: "custom-nav-user-icon",
      html: `
        <div class="relative flex items-center justify-center" style="width: 28px; height: 28px;">
          <div class="absolute rounded-full bg-sky-500 opacity-40 animate-ping" style="width: 28px; height: 28px;"></div>
          <div class="rounded-full bg-sky-600 border-2 border-white shadow-lg flex items-center justify-center text-white" style="width: 18px; height: 18px;">
            <div class="w-2 h-2 rounded-full bg-white"></div>
          </div>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    L.marker([activeLoc.lat, activeLoc.lng], { icon: userIcon })
      .bindTooltip(isArabic ? "📍 موقعك الحالي (مركز الملاحة)" : "📍 Votre Position", { permanent: false })
      .addTo(group);

    // 2. Draw Range Perimeter Circle (15km, 30km, 50km, 100km)
    L.circle([activeLoc.lat, activeLoc.lng], {
      radius: radarRange * 1000,
      color: "#ef4444",
      weight: 1.5,
      dashArray: "6, 8",
      fillColor: "#ef4444",
      fillOpacity: 0.03,
      interactive: false,
    }).addTo(group);

    // 3. Draw Active Hazards (Reports + Satellites)
    hazardsWithDistance
      .filter((f) => f.distance <= radarRange)
      .forEach((fire) => {
        const isSat = fire.type === "satellite";
        const fireIcon = L.divIcon({
          className: "custom-nav-fire-icon",
          html: `
            <div class="relative flex items-center justify-center" style="width: 26px; height: 26px;">
              <div class="absolute rounded-full ${isSat ? "bg-amber-500" : "bg-red-600"} opacity-50 animate-ping" style="width: 26px; height: 26px;"></div>
              <div class="rounded-full ${isSat ? "bg-amber-600" : "bg-red-600"} border-2 border-white text-white font-black text-xs flex items-center justify-center shadow-md" style="width: 20px; height: 20px;">
                ${isSat ? "🛰️" : "🔥"}
              </div>
            </div>
          `,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });

        L.marker([fire.lat, fire.lng], { icon: fireIcon })
          .bindPopup(`
            <div class="p-2 text-slate-100 text-xs font-sans" dir="${isArabic ? "rtl" : "ltr"}">
              <strong class="${isSat ? "text-amber-400" : "text-red-400"} font-bold text-sm">${isSat ? "🛰️" : "🔥"} ${fire.locationName}</strong>
              <p class="mt-1 text-slate-300">الربط الجغرافي: ${fire.distance.toFixed(1)} كم</p>
              <p class="text-[10px] text-slate-400">${fire.description}</p>
            </div>
          `)
          .addTo(group);

        // Draw line connecting user to fire hazard
        L.polyline(
          [
            [activeLoc.lat, activeLoc.lng],
            [fire.lat, fire.lng],
          ],
          {
            color: isSat ? "#f59e0b" : "#ef4444",
            weight: 2,
            dashArray: "4, 6",
            opacity: 0.7,
          }
        ).addTo(group);
      });

    // 4. Calculate & Draw Tactical Safe Evacuation Line (Green Vector Arrow - Inland Guaranteed)
    // ONLY show if the closest fire is dangerously close (e.g., within 15 km)
    if (closestFire && closestFire.distance <= 15) {
      const safeDistanceKm = Math.min(15, Math.max(5, closestFire.distance * 1.5));
      const safeRad = (safeHeading * Math.PI) / 180;
      const dLat = (safeDistanceKm / 111) * Math.cos(safeRad);
      const dLng = (safeDistanceKm / (111 * Math.cos((activeLoc.lat * Math.PI) / 180))) * Math.sin(safeRad);

      const safeTargetLat = activeLoc.lat + dLat;
      const safeTargetLng = activeLoc.lng + dLng;

      // Draw thick emerald green evacuation path
      if (routeCoords && routeCoords.length > 0) {
        L.polyline(routeCoords, {
          color: "#10b981",
          weight: 5,
          opacity: 0.9,
        }).addTo(group);
      } else {
        L.polyline(
          [
            [activeLoc.lat, activeLoc.lng],
            [safeTargetLat, safeTargetLng],
          ],
          {
            color: "#10b981",
            weight: 4,
            opacity: 0.9,
            dashArray: "8, 8",
          }
        ).addTo(group);
      }

      const endPointLat = routeCoords && routeCoords.length > 0 ? routeCoords[routeCoords.length - 1][0] : safeTargetLat;
      const endPointLng = routeCoords && routeCoords.length > 0 ? routeCoords[routeCoords.length - 1][1] : safeTargetLng;

      const safeIcon = L.divIcon({
        className: "custom-nav-safe-icon",
        html: `
          <div class="flex items-center justify-center bg-emerald-500 border-2 border-white rounded-full text-slate-950 font-black text-xs shadow-lg animate-bounce" style="width: 28px; height: 28px;">
            🟢
          </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      L.marker([endPointLat, endPointLng], { icon: safeIcon })
        .bindTooltip(
          isArabic
            ? `🟢 مسار الهروب البري الآمن (${safeHeading.toFixed(0)}° - ${getBearingDirection(safeHeading)})`
            : `🟢 Voie d'évacuation terrestre (${safeHeading.toFixed(0)}°)`,
          { permanent: true, direction: "top", className: "bg-emerald-950 text-emerald-300 border-emerald-500/40 text-[10px] font-bold" }
        )
        .addTo(group);
    }
  }, [activeLoc, hazardsWithDistance, radarRange, closestFire, safeHeading, isArabic, routeCoords]);

  // Center map back to user
  const handleRecenter = () => {
    if (mapRef.current) {
      mapRef.current.setView([activeLoc.lat, activeLoc.lng], 11, { animate: true });
    }
  };

  const copyFrequency = (freq: string) => {
    navigator.clipboard.writeText(freq);
    setCopiedFreq(freq);
    setTimeout(() => setCopiedFreq(null), 2000);
  };

  // Radio channels directory dataset
  const radioChannels = [
    { nameAr: "الحماية المدنية - قناة العمليات المركزية", nameFr: "Protection Civile - Opérations", freq: "166.250 MHz", type: "VHF", usage: "البلاغات وتنسيق الإخلاء الرسمي" },
    { nameAr: "إدارة الغابات - مكافحة الحرائق", nameFr: "Direction des Forêts", freq: "154.300 MHz", type: "VHF", usage: "متابعة فرق الإطفاء والخطوط الأولى" },
    { nameAr: "أجهزة ألكي تالكي الفردية - قناة الاستغاثة 1", nameFr: "PMR446 - Can. 1 SOS", freq: "446.00625 MHz", type: "UHF (PMR1)", usage: "استغاثة المواطنين والمنكوبين" },
    { nameAr: "أجهزة ألكي تالكي الفردية - قناة التطوع 8", nameFr: "PMR446 - Can. 8 Volontaires", freq: "446.09375 MHz", type: "UHF (PMR8)", usage: "تنسيق القوافل الأهلية والفرق الميدانية" },
    { nameAr: "شبكة طوارئ هواة الراديو (AREN)", nameFr: "Amateur Radio Emergency", freq: "145.500 MHz", type: "VHF Simplex", usage: "ربط الولايات في حال انقطاع الشبكة" },
    { nameAr: "تردد UHF السريع للطوارئ", nameFr: "UHF Emergency Simplex", freq: "433.500 MHz", type: "UHF LPD", usage: "الاتصالات المباشرة قصيرة المدى" },
    { nameAr: "الإذاعة الوطنية (القناة الأولى/الصومام)", nameFr: "Radio Soummam / Chaîne 1", freq: "98.2 FM / 91.5 FM", type: "FM Broadcast", usage: "البيانات الرسمية وتنبيهات الإخلاء" },
  ];

  return (
    <div className="bg-zinc-900/60 border border-red-500/10 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)] font-mono text-slate-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-white/5 pb-4 mb-4 gap-3">
        <div className="flex items-center gap-2">
          <Compass className="h-5 w-5 text-red-500 animate-spin" style={{ animationDuration: "12s" }} />
          <div>
            <h3 className="font-bold text-base text-slate-100 flex items-center gap-2">
              <span>{isArabic ? "رادار الملاحة والتوجيه الميداني والإخلاء البري" : "Carte Navigation & Radar Évacuation"}</span>
            </h3>
            <p className="text-[10px] text-slate-400 mt-0.5">
              {isArabic 
                ? "خريطة الملاحة البرية التكتيكية لمسارات الهروب وتفادي البحر والبؤر النشطة (NASA + بلاغات)" 
                : "Navigation tactique terrestre évitant la mer et les brasiers"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Radio Frequencies Button */}
          <button
            type="button"
            onClick={() => setShowRadioGuide(!showRadioGuide)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-950/60 hover:bg-amber-900 border border-amber-500/40 text-amber-300 rounded-lg text-xs font-bold transition-all cursor-pointer shadow-md"
          >
            <Radio className="h-4 w-4 animate-pulse text-amber-400" />
            <span>{isArabic ? "📻 دليل ترددات اللاسلكي (UHF/VHF)" : "📻 Fréquences Radio"}</span>
          </button>

          {/* Dynamic Wind Status Widget */}
          <div className="flex items-center gap-3 bg-red-950/20 border border-red-500/20 p-2 rounded-lg text-xs">
            <Wind className="h-4 w-4 text-orange-400 animate-pulse" />
            <div>
              <p className="text-[10px] text-gray-400">{isArabic ? "ناقل الرياح السطحية" : "Vent & Vitesse"}</p>
              <p className="font-bold text-orange-400">
                {wind.speed} km/h • {getDirectionName(wind.direction)} ({wind.temperature}°C)
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* RADIO FREQUENCIES DRAWER / PANEL */}
      {showRadioGuide && (
        <div className="mb-5 p-4 bg-zinc-950 border border-amber-500/30 rounded-xl shadow-2xl animate-fadeIn">
          <div className="flex items-center justify-between border-b border-amber-500/20 pb-2 mb-3">
            <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
              <Radio className="h-5 w-5" />
              <span>{isArabic ? "دليل ترددات الراديو واللاسلكي للطوارئ (UHF / VHF)" : "Guide des Fréquences Radio Urgence UHF/VHF"}</span>
            </div>
            <button
              onClick={() => setShowRadioGuide(false)}
              className="text-slate-400 hover:text-white text-xs px-2 py-0.5 rounded bg-zinc-800 cursor-pointer"
            >
              ✕
            </button>
          </div>
          <p className="text-xs text-slate-300 mb-3 leading-relaxed">
            {isArabic 
              ? "في حال احتراق أبراج الاتصالات الخلوية وانقطاع شبكات الإنترنت، يمكنك ضبط أجهزة اللاسلكي (Walkie-Talkie) والراديو المحمول على الترددات الميدانية الرسمية التالية لتلقي الاستغاثات والتواصل مع الفرق:"
              : "En cas de panne des réseaux cellulaires, réglez vos radios sur ces fréquences d'urgence:"}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {radioChannels.map((ch, idx) => (
              <div key={idx} className="bg-zinc-900 border border-slate-800 p-2.5 rounded-lg flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="px-1.5 py-0.5 rounded bg-amber-950 text-amber-400 border border-amber-500/30 font-bold text-[10px]">
                      {ch.type}
                    </span>
                    <strong className="text-xs text-slate-100 font-bold">{isArabic ? ch.nameAr : ch.nameFr}</strong>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">{ch.usage}</p>
                </div>
                <button
                  type="button"
                  onClick={() => copyFrequency(ch.freq)}
                  className="px-2.5 py-1 bg-amber-600/20 hover:bg-amber-600/40 border border-amber-500/40 text-amber-300 rounded font-mono font-bold text-xs flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  {copiedFreq === ch.freq ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  <span>{ch.freq}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SEA ROUTING ADJUSTMENT ALERT BADGE */}
      {isSeaAdjusted && (
        <div className="mb-4 bg-amber-950/40 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300 flex items-center gap-2.5 shadow-lg">
          <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 animate-bounce" />
          <span>
            {isArabic
              ? "🛡️ تصحيح أمان تلقائي: تم تعديل مسار الهروب لتفادي التوجه نحو البحر الأبيض المتوسط والابتعاد عن كافة بؤر الحرائق (المرصودة بالأقمار والبلاغات) نحو الطرق البرية الآمنة جنوباً."
              : "🛡️ Trajectoire ajustée: La route d'évacuation contourne la mer Méditerranée et s'oriente vers les voies terrestres sécurisées."}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
        
        {/* INTERACTIVE NAVIGATION MAP CONTAINER (6 cols) */}
        <div className="md:col-span-6 flex flex-col justify-between bg-black/50 border border-white/10 rounded-xl relative overflow-hidden min-h-[340px] h-[360px] shadow-2xl">
          {/* Map Target */}
          <div ref={mapContainerRef} className="w-full h-full relative z-0" />

          {/* Map Top Bar Controls */}
          <div className="absolute top-2 right-2 z-[1000] flex items-center gap-1.5 bg-slate-950/90 border border-slate-800 p-1 rounded-lg backdrop-blur shadow-lg">
            <button
              type="button"
              onClick={() => setNavTileStyle("osm")}
              className={`px-2 py-1 rounded text-[10px] font-bold transition-all cursor-pointer ${
                navTileStyle === "osm" ? "bg-red-600 text-white" : "text-slate-400 hover:text-white"
              }`}
            >
              🗺️ {isArabic ? "طرقات" : "Routes"}
            </button>
            <button
              type="button"
              onClick={() => setNavTileStyle("satellite")}
              className={`px-2 py-1 rounded text-[10px] font-bold transition-all cursor-pointer ${
                navTileStyle === "satellite" ? "bg-red-600 text-white" : "text-slate-400 hover:text-white"
              }`}
            >
              🛰️ {isArabic ? "فضائية" : "Satellite"}
            </button>
            <button
              type="button"
              onClick={() => setNavTileStyle("dark")}
              className={`px-2 py-1 rounded text-[10px] font-bold transition-all cursor-pointer ${
                navTileStyle === "dark" ? "bg-red-600 text-white" : "text-slate-400 hover:text-white"
              }`}
            >
              🌙 {isArabic ? "تكتيكية" : "Dark"}
            </button>
          </div>

          {/* Recenter Button */}
          <button
            type="button"
            onClick={handleRecenter}
            className="absolute bottom-10 right-2 z-[1000] bg-slate-950/90 hover:bg-slate-900 border border-slate-700 text-slate-200 p-1.5 rounded-lg shadow-lg cursor-pointer flex items-center gap-1 text-[10px] font-bold"
            title={isArabic ? "إعادة ضبط الخريطة لموقعك" : "Centrer sur votre position"}
          >
            <Navigation className="h-3.5 w-3.5 text-sky-400" />
            <span>{isArabic ? "موقعي" : "Position"}</span>
          </button>

          {/* Bottom Bar: Range selector & OpenMeteo live badge */}
          <div className="absolute bottom-0 inset-x-0 z-[1000] bg-slate-950/90 border-t border-slate-800 p-2 backdrop-blur flex flex-wrap items-center justify-between gap-2 text-[9px] text-slate-300">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400 font-bold mr-1">{isArabic ? "نطاق الرادار:" : "Portée:"}</span>
              <button
                type="button"
                onClick={() => setRadarRange(15)}
                className={`px-1.5 py-0.5 rounded text-[9px] font-bold cursor-pointer transition-all ${
                  radarRange === 15 ? "bg-red-600 text-white" : "bg-slate-800 text-slate-400 hover:text-white"
                }`}
              >
                15KM
              </button>
              <button
                type="button"
                onClick={() => setRadarRange(30)}
                className={`px-1.5 py-0.5 rounded text-[9px] font-bold cursor-pointer transition-all ${
                  radarRange === 30 ? "bg-red-600 text-white" : "bg-slate-800 text-slate-400 hover:text-white"
                }`}
              >
                30KM
              </button>
              <button
                type="button"
                onClick={() => setRadarRange(50)}
                className={`px-1.5 py-0.5 rounded text-[9px] font-bold cursor-pointer transition-all ${
                  radarRange === 50 ? "bg-red-600 text-white" : "bg-slate-800 text-slate-400 hover:text-white"
                }`}
              >
                50KM
              </button>
              <button
                type="button"
                onClick={() => setRadarRange(100)}
                className={`px-1.5 py-0.5 rounded text-[9px] font-bold cursor-pointer transition-all ${
                  radarRange === 100 ? "bg-red-600 text-white" : "bg-slate-800 text-slate-400 hover:text-white"
                }`}
              >
                100KM
              </button>
            </div>
            <span className="text-[9px] text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30 font-mono font-bold">
              {wind.isLive ? "📡 LIVE Open-Meteo" : "🛰️ Weather Model"}
            </span>
          </div>
        </div>

        {/* REVERSE EVACUATION TELEMETRY DATA PANEL (6 cols) */}
        <div className="md:col-span-6 space-y-3.5">
          {closestFire ? (
            <div className="space-y-3">
              <div className="bg-red-950/20 border border-red-500/20 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-red-400">
                  <AlertTriangle className="h-4 w-4 text-red-500 animate-bounce" />
                  <span>{isArabic ? "تم رصد مهدد حريق نشط ومقرب!" : "Alerte : Foyer d'Incendie Actif Proche !"}</span>
                </div>
                <p className="text-[11px] text-slate-300">
                  {isArabic 
                    ? `أقرب بؤرة لهب تقع في "${closestFire.locationName}" على بعد ${closestFire.distance.toFixed(1)} كلم بالاتجاه ${closestFire.bearing.toFixed(0)}° (${getDirectionName(closestFire.bearing)}).`
                    : `Le foyer le plus proche est situé à "${closestFire.locationName}" (${closestFire.distance.toFixed(1)} km) à l'angle ${closestFire.bearing.toFixed(0)}° (${getDirectionName(closestFire.bearing)}).`
                  }
                </p>
                <div className="text-[10px] text-orange-400 font-extrabold flex items-center gap-1 border-t border-red-500/10 pt-1.5 mt-1.5">
                  ⚠️ {isArabic 
                    ? `اتجاه انتشار ألسنة اللهب المتوقع (مع اتجاه الرياح): ${driftHeading.toFixed(0)}° (${getDirectionName(driftHeading)})`
                    : `Dérive attendue de la propagation du feu : ${driftHeading.toFixed(0)}° (${getDirectionName(driftHeading)})`}
                </div>
              </div>

              {/* RECOMMENDED REVERSE ESCAPE ROUTE */}
              {closestFire.distance <= 15 ? (
                <div className="bg-emerald-950/20 border border-emerald-500/30 rounded-lg p-3 space-y-2 animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black text-emerald-400 flex items-center gap-1">
                      <ShieldCheck className="h-4 w-4" />
                      <span>{isArabic ? "مسار الإخلاء التكتيكي الموصى به" : "VECTEUR D'ÉVACUATION RECOMMANDÉ"}</span>
                    </span>
                    <span className="bg-emerald-500 text-slate-950 font-black px-1.5 py-0.5 rounded text-[10px]">
                      {safeHeading.toFixed(0)}° {getBearingDirection(safeHeading)}
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-full flex items-center justify-center font-black animate-pulse shrink-0">
                      {getBearingDirection(safeHeading)}
                    </div>
                    <div className="flex-1 text-[11px] text-slate-300 leading-normal">
                      <p className="font-bold text-emerald-400 mb-1">
                        {isArabic ? `توجه فوراً نحو: ${getDirectionName(safeHeading)}` : `Évacuer immédiatement vers : ${getDirectionName(safeHeading)}`}
                      </p>
                      {evacRouteMeta ? (
                        <div className="flex gap-2 mb-1">
                          <span className="bg-emerald-950/50 border border-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded text-[9px] font-mono">
                            🛣️ {evacRouteMeta.distance.toFixed(1)} km
                          </span>
                          <span className="bg-emerald-950/50 border border-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded text-[9px] font-mono">
                            ⏱️ {Math.ceil(evacRouteMeta.duration)} min
                          </span>
                        </div>
                      ) : null}
                      <p className="text-[10px] text-gray-400 mt-1">
                        {isArabic 
                          ? `يرجى اتباع المسار المظلل باللون الأخضر على الخريطة (مسار موجه عبر شبكة الطرق المعتمدة). وتجنب التقدم نحو ${getDirectionName(driftHeading)}.`
                          : `Suivez l'itinéraire vert sur la carte (calculé via le réseau routier). Évitez absolument le secteur ${getDirectionName(driftHeading)}.`
                        }
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3 flex items-start gap-3">
                  <ShieldCheck className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-bold text-emerald-400">
                      {isArabic ? "أنت في مسافة آمنة حالياً" : "Vous êtes à une distance de sécurité"}
                    </p>
                    <p className="text-[10px] text-slate-400 mt-1">
                      {isArabic 
                        ? `لا توجد حاجة للإخلاء الفوري. أقرب حريق يبعد عنك مسافة آمنة (${closestFire.distance.toFixed(1)} كم). يرجى البقاء متيقظاً.`
                        : `Aucune évacuation immédiate requise. Le feu le plus proche est à distance sûre (${closestFire.distance.toFixed(1)} km). Restez vigilant.`}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-emerald-950/10 border border-emerald-500/10 rounded-lg p-5 text-center space-y-2">
              <div className="text-3xl">🛡️</div>
              <p className="font-bold text-emerald-400 text-xs">{isArabic ? "سماء المنطقة خالية من البؤر النشطة المجاورة" : "Secteur de Navigation Complètement Sûr"}</p>
              <p className="text-[10px] text-gray-400 max-w-sm mx-auto">
                {isArabic 
                  ? "لا توجد بلاغات حريق مؤكدة على مدى 30 كم من موقعك. يمكنك رصد البؤر البعيدة أو تصفح الخريطة التفاعلية."
                  : "Aucun foyer d'incendie actif répertorié dans un rayon de 30 km. Votre périmètre actuel est sous contrôle."}
              </p>
            </div>
          )}

          {/* Quick instructions block */}
          <div className="bg-black/40 border border-white/5 rounded-lg p-3 text-[10px] space-y-1.5 leading-relaxed text-gray-400">
            <p className="font-bold text-slate-300 text-[11px] flex items-center gap-1">
              <HelpCircle className="h-3.5 w-3.5 text-gray-500" />
              <span>{isArabic ? "بروتوكول السلامة تحت النيران الكثيفة:" : "Protocole d'urgence évacuation :"}</span>
            </p>
            <p>• {isArabic ? "تحرك دائماً عكس اتجاه الرياح (مواجهةً للريح) لتجنب الاختناق السريع بالغازات السامة والدخان الأسود." : "Marchez toujours face au vent (à contre-vent) pour éviter l'asphyxie par le CO2."}</p>
            <p>• {isArabic ? "احمِ مسالكك التنفسية بقطعة قماش مبللة بالماء وتوجه مباشرةً نحو التجمعات السكنية المكشوفة أو الشواطئ الآمنة." : "Protégez vos voies respiratoires avec un linge humide et visez les clairières rocheuses ou plages."}</p>
          </div>
        </div>

      </div>
    </div>
  );
}

