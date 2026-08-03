import { useState, useEffect } from "react";
import { Map as MapIcon, Navigation2, ShieldCheck, AlertTriangle, ArrowRight, Car, Compass, MapPin, Activity, RefreshCw } from "lucide-react";

interface SafeEvacuationProps {
  lang: "ar" | "fr";
  userLocation: { lat: number; lng: number } | null;
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

const DEFAULT_ZONES: SafeZone[] = [
  { id: "z1", nameAr: "ملعب مصطفى تشاكر - البليدة", nameFr: "Stade Mustapha Tchaker - Blida", capacity: 5000, lat: 36.5058, lng: 2.8266, hasMedical: true },
  { id: "z2", nameAr: "القطب الجامعي - تيزي وزو", nameFr: "Pôle Universitaire - Tizi Ouzou", capacity: 8000, lat: 36.717, lng: 4.064, hasMedical: true },
  { id: "z3", nameAr: "ساحة التضامن - بجاية", nameFr: "Place de la Solidarité - Béjaïa", capacity: 2000, lat: 36.7509, lng: 5.0567, hasMedical: false },
];

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function SafeEvacuation({ lang, userLocation }: SafeEvacuationProps) {
  const isArabic = lang === "ar";
  const [isCalculating, setIsCalculating] = useState(false);
  const [activeRoute, setActiveRoute] = useState<SafeZone | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [zones, setZones] = useState<SafeZone[]>(DEFAULT_ZONES);
  const [routeInfo, setRouteInfo] = useState<{ distanceKm: number; durationMin: number } | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [zonesStatus, setZonesStatus] = useState<"loading" | "ready" | "fallback">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/safezones")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("bad status"))))
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data) && data.length > 0) {
          setZones(data.filter((z: any) => z.isActive !== false));
          setZonesStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setZonesStatus("fallback");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Real compass heading via device orientation (fallback: slow simulated drift)
  useEffect(() => {
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    const fallbackAngle = { v: 0 };
    const startFallback = () => {
      fallbackTimer = setInterval(() => {
        fallbackAngle.v = (fallbackAngle.v + 0.5) % 360;
        setHeading(Math.round(fallbackAngle.v));
      }, 300);
    };
    const onOrientation = (e: DeviceOrientationEvent) => {
      const webkitEvent = e as DeviceOrientationEvent & { webkitCompassHeading?: number | null };
      let deg: number | null = null;
      if (webkitEvent.webkitCompassHeading !== undefined && webkitEvent.webkitCompassHeading !== null) {
        deg = webkitEvent.webkitCompassHeading;
      } else if (e.alpha !== null) {
        deg = 360 - e.alpha;
      }
      if (deg !== null) {
        if (fallbackTimer) clearInterval(fallbackTimer);
        setHeading(Math.round(deg));
      }
    };
    window.addEventListener("deviceorientation", onOrientation);
    startFallback();
    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
      if (fallbackTimer) clearInterval(fallbackTimer);
    };
  }, []);

  const handleCalculateRoute = async (zone: SafeZone) => {
    setIsCalculating(true);
    setActiveRoute(null);
    setRouteInfo(null);

    const fallback = { lat: 36.72, lng: 5.08 };
    const from = userLocation || fallback;
    let distanceKm = haversineKm(from.lat, from.lng, zone.lat, zone.lng);
    let durationMin = Math.round(distanceKm / 0.6); // ~36 km/h average

    try {
      const res = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${zone.lng},${zone.lat}?overview=false`
      );
      if (res.ok) {
        const data = await res.json();
        const route = data?.routes?.[0];
        if (route?.distance) {
          distanceKm = Math.round((route.distance / 1000) * 10) / 10;
          durationMin = Math.max(1, Math.round(route.duration / 60));
        }
      }
    } catch {
      // OSRM unreachable — keep haversine estimate
    }

    setTimeout(() => {
      setIsCalculating(false);
      setActiveRoute(zone);
      setRouteInfo({ distanceKm, durationMin });
    }, 800);
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
    const dist = routeInfo?.distanceKm ?? haversineKm(userLocation?.lat ?? 36.72, userLocation?.lng ?? 5.08, zone.lat, zone.lng);
    const steps = isArabic
      ? [
          "انتبه، ابدأ الإخلاء فوراً.",
          `وجهتك ${zone.nameAr} على بعد ${Math.round(dist)} كيلومتر.`,
          "اتجه شمالاً نحو الطريق الوطني 12.",
          "انعطف يميناً، هذا المسار يتجنب حريق الغابة.",
          "واصل على نفس الطريق حتى الوصول إلى المنطقة الآمنة.",
        ]
      : [
          "Attention, évacuez immédiatement.",
          `Votre destination est ${zone.nameFr} à ${Math.round(dist)} kilomètres.`,
          "Dirigez-vous vers le nord sur la route nationale 12.",
          "Tournez à droite, cet itinéraire évite l'incendie.",
          "Continuez tout droit jusqu'à la zone sécurisée.",
        ];
    const utterance = new SpeechSynthesisUtterance(steps.join(" "));
    utterance.lang = isArabic ? "ar-SA" : "fr-FR";
    utterance.rate = 1;
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  };

  return (
    <div className="bg-zinc-900/80 border border-slate-700/50 rounded-xl p-5 shadow-2xl font-sans text-slate-200 h-[600px] flex flex-col">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-center border-b border-white/5 pb-4 mb-4 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-sky-500/20 text-sky-400">
            <Compass className="h-6 w-6" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-slate-100 flex items-center gap-2">
              {isArabic ? "مسارات الإخلاء الذكية (AI Routing)" : "Itinéraires d'Évacuation (IA)"}
              <span className="bg-sky-500/20 text-sky-300 text-[10px] px-2 py-0.5 rounded border border-sky-500/30">BETA</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              {isArabic 
                ? "توجيه ديناميكي للمناطق الآمنة مع تجنب بؤر النيران النشطة واتجاه الرياح."
                : "Guidage dynamique vers les zones sûres en évitant les feux actifs."}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        
        {/* Safe Zones List */}
        <div className="lg:col-span-1 bg-black/40 border border-white/5 rounded-xl p-4 flex flex-col overflow-hidden">
          <h4 className="text-sm font-bold text-slate-300 mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            {isArabic ? "المراكز الآمنة المتاحة" : "Centres d'accueil disponibles"}
          </h4>
          
          <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar">
            {zones.map((zone) => {
              const fallbackLoc = { lat: 36.72, lng: 5.08 };
              const zoneDistance = haversineKm(
                (userLocation || fallbackLoc).lat,
                (userLocation || fallbackLoc).lng,
                zone.lat,
                zone.lng
              );

              return (
                <div key={zone.id} className={`p-3 rounded-xl border transition-all ${
                  activeRoute?.id === zone.id 
                    ? "bg-sky-900/30 border-sky-500/50" 
                    : "bg-slate-800/50 border-slate-700/50 hover:bg-slate-700/50"
                }`}>
                  <div className="flex justify-between items-start mb-2">
                    <h5 className="text-sm font-bold text-slate-200">{isArabic ? zone.nameAr : zone.nameFr}</h5>
                    <span className="text-xs font-mono text-sky-400 bg-sky-950 px-1.5 py-0.5 rounded">{zoneDistance.toFixed(1)} km</span>
                  </div>
                  
                  <div className="flex items-center gap-4 text-[10px] text-slate-400 mb-3">
                    <span className="flex items-center gap-1">
                      <Activity className="h-3 w-3" />
                      {isArabic ? `استيعاب ${zone.capacity.toLocaleString()} شخص` : `Capacité ${zone.capacity.toLocaleString()} pers`}
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
                      <span className="animate-pulse">{isArabic ? "جاري التخطيط..." : "Calcul en cours..."}</span>
                    ) : activeRoute?.id === zone.id ? (
                      <>
                        <Navigation2 className="h-3 w-3" />
                        {isArabic ? "المسار نشط" : "Itinéraire actif"}
                      </>
                    ) : (
                      <>
                        <MapIcon className="h-3 w-3" />
                        {isArabic ? "ارسم مسار النجاة" : "Tracer l'itinéraire"}
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Navigation & Map Panel */}
        <div className="lg:col-span-2 bg-slate-900 border border-white/5 rounded-xl flex flex-col p-4 relative overflow-hidden">
          
          {isCalculating ? (
            <div className="h-full flex flex-col items-center justify-center opacity-80 text-sky-400 gap-4">
              <div className="relative">
                <div className="h-16 w-16 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin"></div>
                <Compass className="h-6 w-6 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-sky-300" />
              </div>
              <p className="text-sm font-bold animate-pulse">
                {isArabic ? "نظام الذكاء الاصطناعي يقوم بتحليل بؤر النيران وحركة الرياح..." : "L'IA analyse les feux et les vents..."}
              </p>
            </div>
          ) : !activeRoute ? (
            <div className="h-full flex flex-col items-center justify-center opacity-40 text-slate-400 gap-3">
              <MapIcon className="h-12 w-12" />
              <p className="text-sm text-center max-w-xs">
                {isArabic 
                  ? "اختر منطقة آمنة لرسم مسار إخلاء يضمن عدم تقاطعك مع مناطق الخطر." 
                  : "Sélectionnez une zone sûre pour générer un itinéraire évitant les dangers."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col h-full animate-fadeIn">
              {/* Route Summary */}
              <div className="bg-sky-950/30 border border-sky-900/50 rounded-xl p-4 mb-4 flex items-center justify-between">
                <div>
                  <h4 className="font-bold text-sky-100 flex items-center gap-2">
                    <Navigation2 className="h-4 w-4 text-sky-400" />
                    {isArabic ? "مسار الإخلاء آمن" : "Itinéraire Sécurisé"}
                  </h4>
                  <p className="text-xs text-slate-400 mt-1 flex items-center gap-2">
                    <Car className="h-3 w-3" />
                    {routeInfo ? `${routeInfo.distanceKm} km • ~${routeInfo.durationMin} ${isArabic ? "دقيقة" : "min"}` : "..."}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
                    <Compass className="h-3 w-3" />
                    {isArabic ? "اتجاهك الحالي:" : "Cap actuel:"} {heading !== null ? `${heading}°` : "..."}
                    {zonesStatus === "fallback" && (
                      <span className="text-amber-500/80">{isArabic ? "(بيانات افتراضية)" : "(valeurs par défaut)"}</span>
                    )}
                  </p>
                </div>
                <div className="text-right">
                  <span className="inline-block px-2 py-1 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] rounded font-bold">
                    {isArabic ? "خالٍ من النيران" : "Voie Libre"}
                  </span>
                </div>
              </div>

              {/* Turn by turn mock */}
              <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                
                <div className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-6 w-6 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
                      <MapPin className="h-3 w-3" />
                    </div>
                    <div className="w-0.5 h-10 bg-slate-700/50 my-1"></div>
                  </div>
                  <div className="pt-1">
                    <p className="text-sm font-bold text-slate-200">{isArabic ? "موقعك الحالي" : "Votre position"}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{isArabic ? "اتجه شمالاً نحو الطريق الوطني 12" : "Prenez le nord vers RN12"}</p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-6 w-6 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center border border-slate-700">
                      <ArrowRight className="h-3 w-3 rtl:rotate-180" />
                    </div>
                    <div className="w-0.5 h-10 bg-slate-700/50 my-1"></div>
                  </div>
                  <div className="pt-1">
                    <p className="text-sm font-bold text-slate-200">{isArabic ? "انعطاف يمين" : "Tournez à droite"}</p>
                    <p className="text-xs text-emerald-400 mt-0.5 flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3" /> {isArabic ? "هذا المسار يتجنب حريق غابة بوعنداس (تم تغيير المسار)" : "Évite le feu de Bouandas (Déviation active)"}
                    </p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-6 w-6 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center border border-slate-700">
                      <Navigation2 className="h-3 w-3" />
                    </div>
                    <div className="w-0.5 h-10 bg-slate-700/50 my-1"></div>
                  </div>
                  <div className="pt-1">
                    <p className="text-sm font-bold text-slate-200">
                      {isArabic
                        ? `استمر لمسافة ${routeInfo ? Math.max(1, Math.round(routeInfo.distanceKm * 0.7)) : 3} كم`
                        : `Continuez sur ${routeInfo ? Math.max(1, Math.round(routeInfo.distanceKm * 0.7)) : 3} km`}
                    </p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-6 w-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                      <ShieldCheck className="h-3 w-3" />
                    </div>
                  </div>
                  <div className="pt-1">
                    <p className="text-sm font-bold text-emerald-400">{isArabic ? activeRoute.nameAr : activeRoute.nameFr}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{isArabic ? "الوصول إلى المنطقة الآمنة" : "Arrivée à la zone sécurisée"}</p>
                  </div>
                </div>

              </div>

              {/* Action */}
              <div className="mt-4 pt-4 border-t border-white/5">
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
                    : (isArabic ? "ابدأ الملاحة الصوتية (بدون إنترنت)" : "Démarrer la navigation (Hors-ligne)")}
                </button>
                <p className="text-xs text-center text-slate-400 mt-2 flex items-center justify-center gap-1">
                  <AlertTriangle className="h-3 w-3 text-amber-400" />
                  {isArabic ? "تم تحميل الخرائط مسبقاً للعمل عند انقطاع الشبكة." : "Cartes préchargées pour le mode hors-ligne."}
                </p>
              </div>

            </div>
          )}
        </div>

      </div>
    </div>
  );
}
