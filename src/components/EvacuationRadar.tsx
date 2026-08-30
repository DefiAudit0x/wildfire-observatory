import { useState, useEffect, useMemo } from "react";
import { Compass, Wind, AlertTriangle, ShieldCheck, HelpCircle } from "lucide-react";
import { Report } from "../types";
import { haversineKm } from "../utils/geo";

interface EvacuationRadarProps {
  reports: Report[];
  userLocation: { lat: number; lng: number } | null;
  lang: "ar" | "fr";
}

export default function EvacuationRadar({ reports, userLocation, lang }: EvacuationRadarProps) {
  const isArabic = lang === "ar";
  const [wind, setWind] = useState<{
    direction: number;
    speed: number;
    temperature: number;
    isLive: true;
  } | null>(null);

  // Live wind from Open-Meteo (free, no API key) at the user's location
  useEffect(() => {
    let cancelled = false;
    if (!userLocation) {
      setWind(null);
      return;
    }
    const activeLoc = userLocation;
    setWind(null);

    const fetchWind = async () => {
      try {
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${activeLoc.lat.toFixed(2)}&longitude=${activeLoc.lng.toFixed(2)}&current=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`
        );
        if (!res.ok) return;
        const data = await res.json();
        const cur = data?.current;
        if (!cur || !Number.isFinite(cur.temperature_2m) || !Number.isFinite(cur.wind_speed_10m) || !Number.isFinite(cur.wind_direction_10m)) return;
        if (cancelled) return;
        setWind({
          direction: Math.round(cur.wind_direction_10m),
          speed: Math.round(cur.wind_speed_10m * 10) / 10,
          temperature: Math.round(cur.temperature_2m * 10) / 10,
          isLive: true,
        });
      } catch {
        // No live weather means no spread-direction guidance.
      }
    };

    fetchWind();
    const timer = setInterval(fetchWind, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [userLocation?.lat, userLocation?.lng]);

  // Rotate the radar sweep line with CSS animation (no state churn)
  const sweepStyle = `
    @keyframes radar-sweep {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;

  // Compute Haversine distance in km
  const getDistance = (lat1: number, lng1: number, lat2: number, lng2: number) =>
    haversineKm(lat1, lng1, lat2, lng2);

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
    if (!Number.isFinite(angle)) return isArabic ? "غير متاح" : "indisponible";
    const directions = isArabic
      ? ["الشمال 🧭", "الشمال الشرقي ↗️", "الشرق ➡️", "الجنوب الشرقي ↘️", "الجنوب ⬇️", "الجنوب الغربي ↙️", "الغرب ⬅️", "الشمال الغربي ↖️"]
      : ["Nord 🧭", "Nord-Est ↗️", "Est ➡️", "Sud-Est ↘️", "Sud ⬇️", "Sud-Ouest ↙️", "Ouest ⬅️", "Nord-Ouest ↖️"];
    const index = Math.round(((angle % 360) / 45)) % 8;
    return directions[index];
  };

  const getBearingDirection = (angle: number) => {
    if (!Number.isFinite(angle)) return isArabic ? "غير متاح" : "N/A";
    const directions = isArabic
      ? ["شمال", "شمال شرقي", "شرق", "جنوب شرقي", "جنوب", "جنوب غربي", "غرب", "شمال غربي"]
      : ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
    const index = Math.round(((angle % 360) / 45)) % 8;
    return directions[index];
  };

  // Calculate distances to all reports
  const reportsWithDistance = useMemo(() => {
    if (!userLocation) return [];
    return reports
      .filter((r) => r.status === "verified")
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
      .map((r) => {
        const dist = getDistance(userLocation.lat, userLocation.lng, r.lat, r.lng);
        const bearing = getBearing(userLocation.lat, userLocation.lng, r.lat, r.lng);
        return { ...r, distance: dist, bearing };
      })
      .filter((r) => r.distance <= 30)
      .sort((a, b) => a.distance - b.distance);
  }, [reports, userLocation]);

  const closestFire = reportsWithDistance[0];

  // This is only the opposite bearing of the closest verified report, not a safe route.
  const oppositeFireHeading = closestFire ? (closestFire.bearing + 180) % 360 : null;

  // A spread direction is shown only when live wind data is available.
  const driftHeading = wind?.isLive ? (wind.direction + 180) % 360 : null;
  
  return (
    <div className="bg-zinc-900/60 border border-red-500/10 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)] font-mono text-slate-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-white/5 pb-4 mb-4 gap-3">
        <div className="flex items-center gap-2">
          <Compass className="h-5 w-5 text-red-500 animate-spin" style={{ animationDuration: "12s" }} />
          <div>
            <h3 className="font-bold text-base text-slate-100">
              {isArabic ? "رادار التوجيه الذكي ومكافحة الانتشار" : "Radar d'Évacuation Tactique & Propagation"}
            </h3>
            <p className="text-[10px] text-slate-400 mt-0.5">
              {isArabic 
                ? "عرض اتجاه معاكس لأقرب بلاغ مؤكد؛ لا يُثبت ذلك سلامة الطريق أو الإخلاء."
                : "Direction opposée au signalement vérifié le plus proche; cela ne prouve pas la sécurité de la route."}
            </p>
          </div>
        </div>

        {/* Dynamic Wind Status Widget */}
        <div className="flex items-center gap-3 bg-red-950/20 border border-red-500/20 p-2 rounded-lg text-xs">
          <Wind className="h-4 w-4 text-orange-400 animate-pulse" />
          <div>
            <p className="text-[10px] text-gray-400">{isArabic ? "ناقل الرياح السطحية" : "Vent & Vitesse"}</p>
            <p className="font-bold text-orange-400">
              {wind ? `${wind.speed} km/h • ${getDirectionName(wind.direction)} (${wind.temperature}°C)` : (isArabic ? "البيانات غير متاحة" : "Données indisponibles")}
            </p>
          </div>
          <span className={`text-[8px] border border-white/10 rounded px-1 py-0.5 ${wind?.isLive ? "text-emerald-400" : "text-slate-500"}`}
            title={wind?.isLive
              ? (isArabic ? "بيانات جوية حية من Open-Meteo" : "Données météo live Open-Meteo")
              : (isArabic ? "بيانات الرياح الحية غير متاحة؛ لا يتم حساب اتجاه الانتشار" : "Données de vent live indisponibles; aucune propagation n'est calculée")}
          >
            {wind?.isLive ? (isArabic ? "مباشر" : "Live") : (isArabic ? "غير متاح" : "Indisponible")}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
        
        {/* GRAPHICAL RADAR SCANNER SWEEP CONTAINER (4 cols) */}
        <div className="md:col-span-5 flex flex-col items-center justify-center bg-black/40 border border-white/5 p-4 rounded-xl relative overflow-hidden h-64">
          <div className="absolute inset-0 bg-radial-gradient from-transparent to-black/80 pointer-events-none"></div>
          
          {/* Circular radar dial */}
          <div className="relative h-48 w-48 rounded-full border-2 border-red-500/30 flex items-center justify-center shadow-[0_0_20px_rgba(239,68,68,0.05)]">
            {/* Grid concentric rings */}
            <div className="absolute h-36 w-36 rounded-full border border-red-500/20"></div>
            <div className="absolute h-24 w-24 rounded-full border border-red-500/15"></div>
            <div className="absolute h-12 w-12 rounded-full border border-red-500/10"></div>
            
            {/* Crosshairs */}
            <div className="absolute h-full w-px bg-red-500/15"></div>
            <div className="absolute w-full h-px bg-red-500/15"></div>

            {/* Radar Sweep Line (CSS animation — no React state churn) */}
          <style>{sweepStyle}</style>
          <div 
            className="absolute top-0 bottom-1/2 right-1/2 left-0 origin-bottom-right border-r border-red-500/40 bg-gradient-to-l from-red-500/15 to-transparent rounded-tl-full"
            style={{ animation: "radar-sweep 12s linear infinite" }}
          ></div>

            {/* Blips/Fires on radar */}
            {reportsWithDistance.filter((fire) => fire.distance <= 15).slice(0, 3).map((fire, idx) => {
              // Convert polar coords (bearing, distance) to cartesian coords for display
              // Map max distance of 15km to radius of 96px
              const maxDist = 15;
              const normalizedDist = Math.min(1, fire.distance / maxDist);
              const radius = normalizedDist * 80; // max 80px
              const angleRad = ((fire.bearing - 90) * Math.PI) / 180;
              const x = radius * Math.cos(angleRad);
              const y = radius * Math.sin(angleRad);

              return (
                <div
                  key={fire.id}
                  className="absolute h-3.5 w-3.5 bg-red-500 rounded-full flex items-center justify-center animate-ping text-[8px] text-white font-extrabold border border-white"
                  style={{ 
                    transform: `translate(${x}px, ${y}px)`,
                    animationDuration: `${1.2 + idx * 0.4}s`
                  }}
                  title={`${fire.locationName}: ${fire.distance.toFixed(1)} km`}
                >
                  🔥
                </div>
              );
            })}

            {/* User coordinate core blip */}
            <div className="absolute h-3.5 w-3.5 bg-sky-500 border-2 border-white rounded-full shadow-[0_0_8px_rgba(14,165,233,0.8)] z-10 animate-pulse"></div>

            {/* Opposite-bearing reference only; not a safe-exit arrow */}
            {closestFire && oppositeFireHeading !== null && (
              <div 
                className="absolute h-6 w-6 text-amber-400 font-bold z-10"
                style={{
                  transform: `rotate(${oppositeFireHeading}deg) translateY(-85px) rotate(-${oppositeFireHeading}deg)`
                }}
              >
                🟠
              </div>
            )}
          </div>

          <div className="mt-3 flex justify-between w-full text-[9px] text-slate-500 font-semibold uppercase">
            <span>Range: 15KM</span>
            <span>Ref: {isArabic ? "نطاق 15 كم" : "Rayon 15 km"}</span>
          </div>
        </div>

        {/* REVERSE EVACUATION TELEMETRY DATA PANEL (7 cols) */}
        <div className="md:col-span-7 space-y-3.5">
          {closestFire ? (
            <div className="space-y-3">
              <div className="bg-red-950/20 border border-red-500/20 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-red-400">
                  <AlertTriangle className="h-4 w-4 text-red-500 animate-bounce" />
                  <span>{isArabic ? "بلاغ مؤكد قريب ضمن نطاق الرادار" : "Signalement vérifié proche dans le rayon du radar"}</span>
                </div>
                <p className="text-[11px] text-slate-300">
                  {isArabic 
                    ? `أقرب بلاغ مؤكد هو "${closestFire.locationName}" على بعد ${closestFire.distance.toFixed(1)} كلم بالاتجاه ${closestFire.bearing.toFixed(0)}° (${getDirectionName(closestFire.bearing)}).`
                    : `Le signalement vérifié le plus proche est "${closestFire.locationName}" (${closestFire.distance.toFixed(1)} km) à l'angle ${closestFire.bearing.toFixed(0)}° (${getDirectionName(closestFire.bearing)}).`
                  }
                </p>
                <div className="text-[10px] text-orange-400 font-extrabold flex items-center gap-1 border-t border-red-500/10 pt-1.5 mt-1.5">
                  ⚠️ {driftHeading !== null
                    ? (isArabic
                      ? `مرجع اتجاه الرياح فقط، وليس نموذج انتشار حريق: ${driftHeading.toFixed(0)}° (${getDirectionName(driftHeading)})`
                      : `Référence de direction du vent uniquement, pas un modèle de propagation : ${driftHeading.toFixed(0)}° (${getDirectionName(driftHeading)})`)
                    : (isArabic
                      ? "بيانات الرياح الحية غير متاحة؛ لا يتم حساب اتجاه الانتشار."
                      : "Aucune donnée de vent en direct; aucune direction de propagation n'est calculée.")}
                </div>
              </div>

              {/* RECOMMENDED REVERSE ESCAPE ROUTE */}
              <div className="bg-amber-950/20 border border-amber-500/30 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-amber-400 flex items-center gap-1">
                    <ShieldCheck className="h-4 w-4" />
                    <span>{isArabic ? "اتجاه معاكس لأقرب بلاغ" : "DIRECTION OPPOSÉE AU SIGNALEMENT"}</span>
                  </span>
                  <span className="bg-amber-400 text-slate-950 font-black px-1.5 py-0.5 rounded text-[10px]">
                    {oppositeFireHeading?.toFixed(0)}° {getBearingDirection(oppositeFireHeading ?? 0)}
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-full flex items-center justify-center font-black animate-pulse">
                    {getBearingDirection(oppositeFireHeading ?? 0)}
                  </div>
                  <div className="flex-1 text-[11px] text-slate-300 leading-normal">
                    <p className="font-bold text-amber-400">
                      {isArabic ? `هذا اتجاه معاكس لأقرب بلاغ فقط: ${getDirectionName(oppositeFireHeading ?? 0)}` : `Direction opposée au signalement le plus proche uniquement : ${getDirectionName(oppositeFireHeading ?? 0)}`}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-1">
                      {isArabic
                        ? driftHeading !== null
                          ? `لا يثبت هذا الاتجاه سلامة الطريق. تجنب الاتجاه التقريبي للانتشار (${getDirectionName(driftHeading)}) واتبع تعليمات الحماية المدنية.`
                          : "لا توجد بيانات رياح حية؛ لا يمكن استنتاج اتجاه انتشار أو مسار آمن."
                        : driftHeading !== null
                          ? `Cette direction ne prouve pas la sécurité de la route. Évitez la direction approximative de propagation (${getDirectionName(driftHeading)}) et suivez les consignes officielles.`
                          : "Aucune donnée de vent en direct; aucune direction de propagation ou voie sûre ne peut être déduite."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : !userLocation ? (
            <div className="bg-amber-950/10 border border-amber-500/20 rounded-lg p-5 text-center space-y-2">
              <div className="text-3xl">📍</div>
              <p className="font-bold text-amber-400 text-xs">{isArabic ? "حدد موقعك لتشغيل الرادار" : "Activez votre position pour activer le radar"}</p>
              <p className="text-[10px] text-gray-400 max-w-sm mx-auto">
                {isArabic
                  ? "الرادار يحسب المسافات من موقعك؛ لما لم يُحدد الموقع بعد لم يُحتسب أي شيء — هذه ليست رسالة سلامة."
                  : "Le radar calcule depuis votre position; aucune position définie, donc aucun calcul effectué — ceci n'est pas un message de sécurité."}
              </p>
            </div>
          ) : (
            <div className="bg-emerald-950/10 border border-emerald-500/10 rounded-lg p-5 text-center space-y-2">
              <div className="text-3xl">🛡️</div>
              <p className="font-bold text-emerald-400 text-xs">{isArabic ? "لا توجد بلاغات مؤكدة ضمن نطاق الرادار" : "Aucun signalement vérifié dans le rayon du radar"}</p>
              <p className="text-[10px] text-gray-400 max-w-sm mx-auto">
                {isArabic 
                  ? "هذا لا يثبت خلو المنطقة من الخطر؛ راجع الخريطة والمصادر الرسمية قبل اتخاذ قرار."
                  : "Cela ne prouve pas l'absence de danger; consultez la carte et les sources officielles avant toute décision."}
              </p>
            </div>
          )}

          {/* Quick instructions block */}
          <div className="bg-black/40 border border-white/5 rounded-lg p-3 text-[10px] space-y-1.5 leading-relaxed text-gray-400">
            <p className="font-bold text-slate-300 text-[11px] flex items-center gap-1">
              <HelpCircle className="h-3.5 w-3.5 text-gray-500" />
              <span>{isArabic ? "حدود هذا الرادار:" : "Limites du radar :"}</span>
            </p>
            <p>{isArabic ? "البلاغات والرياح المعروضة لا تنشئ مسار إخلاء ولا تثبت اتجاه انتشار الحريق." : "Les signalements et le vent affichés ne créent pas de route d'évacuation et ne prouvent pas la propagation du feu."}</p>
            <p>{isArabic ? "اتبع تعليمات الحماية المدنية والمصادر الرسمية في الميدان." : "Suivez les consignes de la Protection civile et les sources officielles sur le terrain."}</p>
          </div>
        </div>

      </div>
    </div>
  );
}
