import { useState, useEffect, useMemo } from "react";
import { Compass, Wind, AlertTriangle, ShieldCheck, HelpCircle } from "lucide-react";
import { Report, SatelliteHotspot } from "../types";
import { haversineKm } from "../utils/geo";

interface EvacuationRadarProps {
  reports: Report[];
  satellites?: SatelliteHotspot[];
  userLocation: { lat: number; lng: number } | null;
  lang: "ar" | "fr";
}

/**
 * v1.0.4 redesign — the owner called the old CSS-div radar "رادار من عصر
 * الحجري" (a stone-age radar) and he was right: three nested divs, a spinning
 * gradient wedge, an emoji 🔥 and a fixed blue dot that never moved.
 *
 * This rewrite is a real SVG tactical display:
 *  - metric range rings (7.5/15/22.5/30 km) with labels and 8-wind rose ticks
 *  - THREE data layers fused: verified reports, pending reports and FIRMS
 *    satellite hotspots (confidence >= 70) — the satellite layer was never
 *    shown before, although it is the only fire source that needs no report
 *  - live Open-Meteo wind vector (FROM direction) plus the reverse spread
 *    sector (where the wind pushes a fire TOWARDS) drawn as a translucent
 *    cone, clearly labelled as a wind reference, NOT a fire model
 *  - the opposite-bearing escape hint, still honestly disclaimed
 * Every number on the display comes from real data; nothing is simulated.
 */
export default function EvacuationRadar({ reports, satellites = [], userLocation, lang }: EvacuationRadarProps) {
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

  const sweepKeyframes = `
    @keyframes radar-sweep-svg {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes radar-blip-ping {
      0% { r: 5; opacity: 0.85; }
      70% { r: 16; opacity: 0; }
      100% { r: 16; opacity: 0; }
    }
  `;

  const getDistance = (lat1: number, lng1: number, lat2: number, lng2: number) =>
    haversineKm(lat1, lng1, lat2, lng2);

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
      ? ["الشمال", "الشمال الشرقي", "الشرق", "الجنوب الشرقي", "الجنوب", "الجنوب الغربي", "الغرب", "الشمال الغربي"]
      : ["Nord", "Nord-Est", "Est", "Sud-Est", "Sud", "Sud-Ouest", "Ouest", "Nord-Ouest"];
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

  const RANGE_KM = 30;
  const CX = 200;
  const CY = 200;
  const R_PX = 178;

  // bearing (0=N, clockwise) -> SVG cartesian around (CX,CY)
  const polar = (bearingDeg: number, radiusPx: number): [number, number] => {
    const rad = (bearingDeg * Math.PI) / 180;
    return [CX + radiusPx * Math.sin(rad), CY - radiusPx * Math.cos(rad)];
  };

  const kmToPx = (km: number) => Math.max(0, Math.min(1, km / RANGE_KM)) * R_PX;

  interface Blip {
    key: string;
    kind: "verified" | "pending" | "satellite";
    distance: number;
    bearing: number;
    label: string;
    detail: string;
  }

  const blips = useMemo<Blip[]>(() => {
    if (!userLocation) return [];
    const reportBlips: Blip[] = reports
      .filter((r) => (r.status === "verified" || r.status === "pending"))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
      .map((r) => {
        const dist = getDistance(userLocation.lat, userLocation.lng, r.lat, r.lng);
        return {
          key: `rep-${r.id}`,
          kind: r.status === "verified" ? ("verified" as const) : ("pending" as const),
          distance: dist,
          bearing: getBearing(userLocation.lat, userLocation.lng, r.lat, r.lng),
          label: r.locationName || (isArabic ? "بلاغ" : "signalement"),
          detail: `${dist.toFixed(1)} km`,
        };
      });
    const satelliteBlips: Blip[] = satellites
      .filter((s) => s.confidence >= 70)
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
      .map((s) => {
        const dist = getDistance(userLocation.lat, userLocation.lng, s.lat, s.lng);
        return {
          key: `sat-${s.id}`,
          kind: "satellite" as const,
          distance: dist,
          bearing: getBearing(userLocation.lat, userLocation.lng, s.lat, s.lng),
          label: `${isArabic ? "نقطة ساخنة" : "Point chaud"} (${s.satellite})`,
          detail: `${dist.toFixed(1)} km • ${s.confidence}%`,
        };
      });
    return [...reportBlips, ...satelliteBlips]
      .filter((b) => b.distance <= RANGE_KM)
      .sort((a, b) => a.distance - b.distance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports, satellites, userLocation]);

  const closestFire = blips[0];
  const oppositeFireHeading = closestFire ? (closestFire.bearing + 180) % 360 : null;
  const driftHeading = wind?.isLive ? (wind.direction + 180) % 360 : null;

  // Spread sector path: a ±22° cone from the center toward driftHeading.
  const spreadSectorPath = (() => {
    if (driftHeading === null) return null;
    const r = kmToPx(RANGE_KM * 0.55);
    const a1 = driftHeading - 22;
    const a2 = driftHeading + 22;
    const [x1, y1] = polar(a1, r);
    const [x2, y2] = polar(a2, r);
    return `M ${CX} ${CY} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`;
  })();

  // Wind vector arrow: FROM the wind's origin toward the observer point
  // (meteorological direction = where the wind comes FROM).
  const windArrow = (() => {
    if (!wind?.isLive) return null;
    const from = polar(wind.direction, kmToPx(RANGE_KM * 0.62));
    const to = polar(wind.direction, kmToPx(RANGE_KM * 0.25));
    return { x1: from[0], y1: from[1], x2: to[0], y2: to[1] };
  })();

  const ringKm = [7.5, 15, 22.5, 30];
  const rose = isArabic
    ? [{ l: "ش", b: 0 }, { l: "شرق", b: 90 }, { l: "ج", b: 180 }, { l: "غرب", b: 270 }]
    : [{ l: "N", b: 0 }, { l: "E", b: 90 }, { l: "S", b: 180 }, { l: "O", b: 270 }];

  return (
    <div className="bg-zinc-900/60 border border-red-500/10 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)] font-mono text-slate-200">
      <style>{sweepKeyframes}</style>
      <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-white/5 pb-4 mb-4 gap-3">
        <div className="flex items-center gap-2">
          <Compass className="h-5 w-5 text-red-500 animate-spin" style={{ animationDuration: "12s" }} />
          <div>
            <h3 className="font-bold text-base text-slate-100">
              {isArabic ? "رادار التوجيه الذكي ومكافحة الانتشار" : "Radar d'Évacuation Tactique & Propagation"}
            </h3>
            <p className="text-[10px] text-slate-400 mt-0.5">
              {isArabic
                ? "بلاغات موثقة + نقاط الأقمار الصناعية + الرياح الحية في نطاق 30 كم"
                : "Signalements vérifiés + points satellites + vent live dans un rayon de 30 km"}
            </p>
          </div>
        </div>

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

        {/* SVG TACTICAL RADAR */}
        <div className="md:col-span-5 flex flex-col items-center justify-center bg-black/40 border border-white/5 p-3 rounded-xl relative overflow-hidden">
          <svg viewBox="0 0 400 400" className="w-full max-w-[340px]" role="img" aria-label={isArabic ? "رادار تكتيكي" : "Radar tactique"}>
            <defs>
              <radialGradient id="sweepGrad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="rgb(239,68,68)" stopOpacity="0.30" />
                <stop offset="100%" stopColor="rgb(239,68,68)" stopOpacity="0.02" />
              </radialGradient>
              <linearGradient id="spreadGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(249,115,22)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="rgb(249,115,22)" stopOpacity="0.04" />
              </linearGradient>
              <radialGradient id="coreGrad">
                <stop offset="0%" stopColor="rgb(56,189,248)" stopOpacity="0.9" />
                <stop offset="100%" stopColor="rgb(56,189,248)" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* dark dial */}
            <circle cx={CX} cy={CY} r={R_PX + 8} fill="rgb(9,9,11)" stroke="rgb(239,68,68)" strokeOpacity="0.35" strokeWidth="2" />

            {/* range rings + km labels */}
            {ringKm.map((km) => (
              <g key={km}>
                <circle cx={CX} cy={CY} r={kmToPx(km)} fill="none" stroke="rgb(239,68,68)" strokeOpacity="0.16" strokeDasharray={km === 30 ? "none" : "3 5"} />
                <text x={CX + 4} y={CY - kmToPx(km) + 11} fill="rgb(148,163,184)" fontSize="9" opacity="0.75">{km}km</text>
              </g>
            ))}

            {/* cross hairs */}
            <line x1={CX - R_PX} y1={CY} x2={CX + R_PX} y2={CY} stroke="rgb(239,68,68)" strokeOpacity="0.12" />
            <line x1={CX} y1={CY - R_PX} x2={CX} y2={CY + R_PX} stroke="rgb(239,68,68)" strokeOpacity="0.12" />
            {/* 45° ticks */}
            {[45, 135, 225, 315].map((b) => {
              const [x1, y1] = polar(b, R_PX - 6);
              const [x2, y2] = polar(b, R_PX + 2);
              return <line key={b} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgb(148,163,184)" strokeOpacity="0.35" strokeWidth="1.5" />;
            })}
            {/* compass rose */}
            {rose.map(({ l, b }) => {
              const [x, y] = polar(b, R_PX - 14);
              return (
                <text key={l} x={x} y={y + 3} textAnchor="middle" fill="rgb(226,232,240)" fontSize="12" fontWeight="bold" opacity="0.85">{l}</text>
              );
            })}

            {/* spread sector (wind reference, NOT a fire model) */}
            {spreadSectorPath && (
              <path d={spreadSectorPath} fill="url(#spreadGrad)" stroke="rgb(249,115,22)" strokeOpacity="0.35" strokeDasharray="4 4" />
            )}

            {/* rotating sweep */}
            <g style={{ transformOrigin: `${CX}px ${CY}px`, animation: "radar-sweep-svg 9s linear infinite" }}>
              <path
                d={`M ${CX} ${CY} L ${CX} ${CY - R_PX} A ${R_PX} ${R_PX} 0 0 1 ${polar(52, R_PX)[0]} ${polar(52, R_PX)[1]} Z`}
                fill="url(#sweepGrad)"
              />
              <line x1={CX} y1={CY} x2={polar(0, R_PX)[0]} y2={polar(0, R_PX)[1]} stroke="rgb(239,68,68)" strokeOpacity="0.5" strokeWidth="1.2" />
            </g>

            {/* wind vector */}
            {windArrow && (
              <g stroke="rgb(251,191,36)" strokeWidth="2" opacity="0.85">
                <line x1={windArrow.x1} y1={windArrow.y1} x2={windArrow.x2} y2={windArrow.y2} />
                <circle cx={windArrow.x1} cy={windArrow.y1} r="3" fill="rgb(251,191,36)" stroke="none" />
              </g>
            )}

            {/* blips: satellite (orange square), pending (amber hollow), verified (red pulsing) */}
            {blips.map((b) => {
              const [x, y] = polar(b.bearing, kmToPx(b.distance));
              if (b.kind === "satellite") {
                return (
                  <g key={b.key}>
                    <title>{`${b.label} — ${b.detail}`}</title>
                    <rect x={x - 4} y={y - 4} width="8" height="8" fill="rgb(251,146,60)" stroke="rgb(255,237,213)" strokeWidth="1" transform={`rotate(45 ${x} ${y})`} />
                  </g>
                );
              }
              if (b.kind === "pending") {
                return (
                  <g key={b.key}>
                    <title>{`${b.label} — ${b.detail}`}</title>
                    <circle cx={x} cy={y} r="4.5" fill="none" stroke="rgb(251,191,36)" strokeWidth="2" />
                  </g>
                );
              }
              return (
                <g key={b.key}>
                  <title>{`${b.label} — ${b.detail}`}</title>
                  <circle cx={x} cy={y} r="5" fill="rgb(239,68,68)" stroke="rgb(254,226,226)" strokeWidth="1.5" />
                  <circle cx={x} cy={y} r="5" fill="none" stroke="rgb(239,68,68)" strokeWidth="2" style={{ animation: "radar-blip-ping 2.2s ease-out infinite" }} />
                </g>
              );
            })}

            {/* observer core */}
            <circle cx={CX} cy={CY} r="26" fill="url(#coreGrad)" />
            <circle cx={CX} cy={CY} r="5" fill="rgb(14,165,233)" stroke="white" strokeWidth="2" />

            {/* opposite-bearing hint marker */}
            {oppositeFireHeading !== null && (() => {
              const [x, y] = polar(oppositeFireHeading, kmToPx(RANGE_KM * 0.93));
              return (
                <g>
                  <title>{isArabic ? "اتجاه معاكس لأقرب خطر (مرجع فقط)" : "Direction opposée au danger le plus proche (référence)"}</title>
                  <circle cx={x} cy={y} r="9" fill="rgb(251,191,36)" fillOpacity="0.2" stroke="rgb(251,191,36)" strokeWidth="1.5" />
                  <text x={x} y={y + 4} textAnchor="middle" fontSize="10" fontWeight="bold" fill="rgb(251,191,36)">←</text>
                </g>
              );
            })()}
          </svg>

          {/* legend */}
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] text-slate-400 w-full max-w-[340px] px-1">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500 inline-block"></span>{isArabic ? "بلاغ مؤكد" : "Signalement vérifié"}</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2 border-amber-400 inline-block"></span>{isArabic ? "بلاغ قيد التحقق" : "En attente"}</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 bg-orange-400 inline-block rotate-45"></span>{isArabic ? "نقطة ساخنة (قمر صناعي)" : "Point chaud satellite"}</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-sky-500 inline-block"></span>{isArabic ? "موقعك" : "Votre position"}</span>
          </div>
          <div className="mt-1 flex justify-between w-full text-[9px] text-slate-500 font-semibold uppercase">
            <span>{isArabic ? "النطاق 30 كم" : "Range: 30 km"}</span>
            <span>{blips.length} {isArabic ? "هدف" : "cibles"}</span>
          </div>
        </div>

        {/* TELEMETRY DATA PANEL */}
        <div className="md:col-span-7 space-y-3.5">
          {closestFire ? (
            <div className="space-y-3">
              <div className="bg-red-950/20 border border-red-500/20 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-red-400">
                  <AlertTriangle className="h-4 w-4 text-red-500 animate-bounce" />
                  <span>
                    {closestFire.kind === "satellite"
                      ? (isArabic ? "نقطة ساخنة قريبة من الأقمار الصناعية ضمن نطاق الرادار" : "Point chaud satellite proche dans le rayon du radar")
                      : (isArabic ? "بلاغ قريب ضمن نطاق الرادار" : "Signalement proche dans le rayon du radar")}
                  </span>
                </div>
                <p className="text-[11px] text-slate-300">
                  {isArabic
                    ? `أقرب مصدر خطر هو "${closestFire.label}" على بعد ${closestFire.distance.toFixed(1)} كلم بالاتجاه ${closestFire.bearing.toFixed(0)}° (${getDirectionName(closestFire.bearing)}).`
                    : `La source la plus proche est "${closestFire.label}" (${closestFire.distance.toFixed(1)} km) à l'angle ${closestFire.bearing.toFixed(0)}° (${getDirectionName(closestFire.bearing)}).`}
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

              <div className="bg-amber-950/20 border border-amber-500/30 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-amber-400 flex items-center gap-1">
                    <ShieldCheck className="h-4 w-4" />
                    <span>{isArabic ? "اتجاه معاكس لأقرب خطر" : "DIRECTION OPPOSÉE AU DANGER"}</span>
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
                      {isArabic ? `هذا اتجاه معاكس لأقرب خطر فقط: ${getDirectionName(oppositeFireHeading ?? 0)}` : `Direction opposée au danger le plus proche uniquement : ${getDirectionName(oppositeFireHeading ?? 0)}`}
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
              <p className="font-bold text-emerald-400 text-xs">{isArabic ? "لا توجد أهداف حريق ضمن نطاق 30 كم" : "Aucune cible incendie dans le rayon de 30 km"}</p>
              <p className="text-[10px] text-gray-400 max-w-sm mx-auto">
                {isArabic
                  ? "هذا لا يثبت خلو المنطقة من الخطر؛ راجع الخريطة والمصادر الرسمية قبل اتخاذ قرار."
                  : "Cela ne prouve pas l'absence de danger; consultez la carte et les sources officielles avant toute décision."}
              </p>
            </div>
          )}

          <div className="bg-black/40 border border-white/5 rounded-lg p-3 text-[10px] space-y-1.5 leading-relaxed text-gray-400">
            <p className="font-bold text-slate-300 text-[11px] flex items-center gap-1">
              <HelpCircle className="h-3.5 w-3.5 text-gray-500" />
              <span>{isArabic ? "حدود هذا الرادار:" : "Limites du radar :"}</span>
            </p>
            <p>{isArabic ? "البلاغات والنقاط الفضائية والرياح المعروضة لا تنشئ مسار إخلاء ولا تثبت اتجاه انتشار الحريق." : "Les signalements, points satellites et le vent affichés ne créent pas de route d'évacuation et ne prouvent pas la propagation du feu."}</p>
            <p>{isArabic ? "اتبع تعليمات الحماية المدنية والمصادر الرسمية في الميدان." : "Suivez les consignes de la Protection civile et les sources officielles sur le terrain."}</p>
          </div>
        </div>

      </div>
    </div>
  );
}
