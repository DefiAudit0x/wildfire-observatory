import { memo } from "react";
import { GeoPoint } from "../../hooks/useProximityAlerts";

interface ProximityAlertBarProps {
  isArabic: boolean;
  activeAlerts: any[];
  userLocation: GeoPoint | null;
  isMuted: boolean;
  onToggleMute: () => void;
  onShowThreat: () => void;
}

function ProximityAlertBar({ isArabic, activeAlerts, userLocation, isMuted, onToggleMute, onShowThreat }: ProximityAlertBarProps) {
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
                ? `رصد ${activeAlerts.length} بؤرة ضمن النطاق التحذيري حولك. الأقرب: "${activeAlerts[0].locationName}" على بعد ${activeAlerts[0].distance.toFixed(1)} كم.`
                : `${activeAlerts.length} foyer(s) détecté(s) dans le rayon d'alerte. Le plus proche : "${activeAlerts[0].locationName}" à ${activeAlerts[0].distance.toFixed(1)} km.`
              }
            </p>
          </div>
        </div>

        {/* Real GPS status and controls */}
        <div className="flex items-center gap-2 flex-wrap text-[10px] font-bold">
          {/* GPS status indicator */}
          <button
            onClick={onShowThreat}
            className={`px-2.5 py-1 rounded border transition-all cursor-pointer ${
              userLocation
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                : "bg-amber-500/20 text-amber-400 border-amber-500/30"
            }`}
            title={isArabic ? "حالة تحديد الموقع الحقيقية" : "État de la localisation GPS"}
          >
            {userLocation
              ? (isArabic ? "🌐 GPS حقيقي: " : "🌐 GPS Réel : ") + `${userLocation.lat.toFixed(3)}, ${userLocation.lng.toFixed(3)}`
              : (isArabic ? "📍 جاري تحديد الموقع..." : "📍 Localisation GPS...")}
          </button>

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