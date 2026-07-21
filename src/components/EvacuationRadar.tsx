import { useState, useEffect } from "react";
import { Compass, Wind, AlertTriangle, ArrowRight, ShieldCheck, HelpCircle } from "lucide-react";
import { Report } from "../types";

interface EvacuationRadarProps {
  reports: Report[];
  userLocation: { lat: number; lng: number } | null;
  lang: "ar" | "fr";
}

export default function EvacuationRadar({ reports, userLocation, lang }: EvacuationRadarProps) {
  const isArabic = lang === "ar";
  const [radarAngle, setRadarAngle] = useState(0);
  
  // Simulated dynamic meteorological wind vector for North Africa
  const [wind, setWind] = useState({
    direction: 260, // degrees (West-South-West)
    speed: 35, // km/h
    temperature: 42, // °C heatwave
  });

  // Rotate the radar sweep line
  useEffect(() => {
    const timer = setInterval(() => {
      setRadarAngle((prev) => (prev + 3) % 360);
    }, 30);
    return () => clearInterval(timer);
  }, []);

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

  // Location near Bejaia / Tizi Ouzou if user geolocation isn't active in sandboxed preview
  const activeLoc = userLocation || { lat: 36.72, lng: 5.08 };

  // Calculate distances to all reports
  const reportsWithDistance = reports
    .map((r) => {
      const dist = getDistance(activeLoc.lat, activeLoc.lng, r.lat, r.lng);
      const bearing = getBearing(activeLoc.lat, activeLoc.lng, r.lat, r.lng);
      return { ...r, distance: dist, bearing };
    })
    .sort((a, b) => a.distance - b.distance);

  const closestFire = reportsWithDistance[0];

  // Calculate optimal evacuation heading (opposite of the closest fire heading)
  const safeHeading = closestFire ? (closestFire.bearing + 180) % 360 : 0;

  // Let's adjust safe heading if the wind is blowing fire toward a direction!
  // Wind direction is from where it blows (260 degrees = from West). Fire spreads to East (80 degrees).
  // If safe direction matches wind drift, warn and adjust.
  const driftHeading = (wind.direction + 180) % 360; // Spread direction
  
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
                ? "حساب مسارات الهروب العكسية الآمنة بناءً على اتجاه البؤر النشطة وسرعة الرياح" 
                : "Calcul des voies de fuite inverses basé sur les brasiers actifs et la dérive du vent"}
            </p>
          </div>
        </div>

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

            {/* Radar Sweep Line */}
            <div 
              className="absolute top-0 bottom-1/2 right-1/2 left-0 origin-bottom-right border-r border-red-500/40 bg-gradient-to-l from-red-500/15 to-transparent rounded-tl-full"
              style={{ transform: `rotate(${radarAngle}deg)` }}
            ></div>

            {/* Blips/Fires on radar */}
            {reportsWithDistance.slice(0, 3).map((fire, idx) => {
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
                  key={idx}
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

            {/* Safe exit arrow blip */}
            {closestFire && (
              <div 
                className="absolute h-6 w-6 text-emerald-400 font-bold z-10"
                style={{
                  transform: `rotate(${safeHeading}deg) translateY(-85px) rotate(-${safeHeading}deg)`
                }}
              >
                🟢
              </div>
            )}
          </div>

          <div className="mt-3 flex justify-between w-full text-[9px] text-slate-500 font-semibold uppercase">
            <span>Range: 15KM</span>
            <span>Ref: {isArabic ? "بجاية / تيزي وزو" : "Béjaïa Grid"}</span>
          </div>
        </div>

        {/* REVERSE EVACUATION TELEMETRY DATA PANEL (7 cols) */}
        <div className="md:col-span-7 space-y-3.5">
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
              <div className="bg-emerald-950/20 border border-emerald-500/30 rounded-lg p-3 space-y-2">
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
                  <div className="h-10 w-10 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-full flex items-center justify-center font-black animate-pulse">
                    {getBearingDirection(safeHeading)}
                  </div>
                  <div className="flex-1 text-[11px] text-slate-300 leading-normal">
                    <p className="font-bold text-emerald-400">
                      {isArabic ? `توجه فوراً بعكس اتجاه الحريق نحو: ${getDirectionName(safeHeading)}` : `Quitter la zone immédiatement vers : ${getDirectionName(safeHeading)}`}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-1">
                      {isArabic 
                        ? `املك الطرق الفرعية الآمنة بعيداً عن الغطاء الغابي الكثيف. وتجنب تماماً التقدم نحو الشرق (${getDirectionName(driftHeading)}) بسبب تزايد معدل الانتشار السريع بدعم من هبات الرياح الحارة.`
                        : `Prenez les routes dégagées hors des zones boisées. Évitez absolument le secteur Est (${getDirectionName(driftHeading)}) en raison de la vélocité de propagation du vent chaud.`
                      }
                    </p>
                  </div>
                </div>
              </div>
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
