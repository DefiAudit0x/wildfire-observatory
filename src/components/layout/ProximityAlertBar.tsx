import { memo } from "react";
import { ProximityAlert } from "../../hooks/useProximityAlerts";

interface ProximityAlertBarProps {
  isArabic: boolean;
  activeAlerts: ProximityAlert[];
  isMuted: boolean;
  onToggleMute: () => void;
  /** Highlights the nearest active alert on the map. */
  onShowThreat: () => void;
}

function ProximityAlertBar({
  isArabic,
  activeAlerts,
  isMuted,
  onToggleMute,
  onShowThreat,
}: ProximityAlertBarProps) {
  return (
    <div className="bg-gradient-to-r from-red-950 via-amber-950/80 to-red-950 border-b border-red-500/30 text-white px-4 py-3 md:px-8 z-[1001]">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row items-center justify-between gap-4 font-mono">
        {/* Left/Right core threat status */}
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-600"></span>
          </span>

          <div className="text-xs">
            <p className="font-extrabold text-red-400 flex items-center gap-1">
              🚨 {isArabic ? "تنبيه: بؤر خطر قريبة من موقعك" : "ALERTE : foyers à proximité de votre position"}
            </p>
            <p className="text-[10.5px] text-slate-200 mt-1 leading-normal">
              {isArabic
                ? `رصد ${activeAlerts.length} بؤرة ضمن النطاق التحذيري (${activeAlerts[0].thresholdKm.toFixed(1)} كم — حسب الخطورة). الأقرب: "${activeAlerts[0].locationName}" على بعد ${activeAlerts[0].distance.toFixed(1)} كم.`
                : `${activeAlerts.length} foyer(s) dans le rayon d'alerte (${activeAlerts[0].thresholdKm.toFixed(1)} km — selon la sévérité). Le plus proche : "${activeAlerts[0].locationName}" à ${activeAlerts[0].distance.toFixed(1)} km.`
              }
            </p>
            {/* Threat semantics (audit): the siren fires on CONFIRMED citizen
                reports only. Satellite hotspots (thermal points, unconfirmed)
                never trigger an alarm — a false siren costs more than a missed
                hotspot. The nearest hotspot is still shown on the map. */}
            <p className="text-[9px] text-amber-300/70 mt-0.5 leading-normal">
              {isArabic
                ? "التنبيهات مبنية على بلاغات المواطنين الموثقة فقط — بقع الأقمار الصناعية الحرارية غير المؤكدة لا تُطلق إنذاراً."
                : "Alarme basée sur les signalements citoyens vérifiés uniquement — les points thermiques satellites (non confirmés) ne déclenchent pas d'alerte."}
            </p>
          </div>
        </div>

        {/* Controls — the GPS status and location-sharing consent live in the
            always-visible LocationStatusBar, NOT here: this bar only renders
            while alerts are active, so it must never be the only home of a
            control that must stay reachable (consent revocation) or an error
            that must stay visible (GPS failure). */}
        <div className="flex items-center gap-2 flex-wrap text-[10px] font-bold">
          <button
            onClick={onToggleMute}
            className="px-2.5 py-1 bg-black/55 hover:bg-black border border-white/10 rounded transition-colors text-slate-300 cursor-pointer"
          >
            {isMuted ? (isArabic ? "🔊 تشغيل الصوت" : "🔊 Activer Son") : (isArabic ? "🔇 كتم صوت الصفارة" : "🔇 Couper Sirène")}
          </button>

          <button
            onClick={onShowThreat}
            className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded shadow-md transition-all cursor-pointer"
          >
            🎯 {isArabic ? "عرض الخطر على الخريطة" : "Voir la menace sur la carte"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(ProximityAlertBar);
