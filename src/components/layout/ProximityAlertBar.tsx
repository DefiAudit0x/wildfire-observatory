import { memo } from "react";
import { GeoPoint, ProximityAlert } from "../../hooks/useProximityAlerts";

interface ProximityAlertBarProps {
  isArabic: boolean;
  activeAlerts: ProximityAlert[];
  userLocation: GeoPoint | null;
  /** Actionable GPS failure (permission/coverage/timeout) from useGeolocation. */
  geoError: string | null;
  isMuted: boolean;
  onToggleMute: () => void;
  /** Fires a one-shot FRESH geolocation request (the GPS button's real action). */
  onRequestLocation: () => void;
  /** Highlights the nearest active alert on the map. */
  onShowThreat: () => void;
  /** Location-sharing consent for the heartbeat (PII audit). */
  locationSharingConsent: boolean;
  onToggleLocationConsent: (granted: boolean) => void;
}

function ProximityAlertBar({
  isArabic,
  activeAlerts,
  userLocation,
  geoError,
  isMuted,
  onToggleMute,
  onRequestLocation,
  onShowThreat,
  locationSharingConsent,
  onToggleLocationConsent,
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

        {/* Real GPS status and controls */}
        <div className="flex items-center gap-2 flex-wrap text-[10px] font-bold">
          {/* GPS status indicator: clicking re-requests a FRESH location fix
              (getCurrentPosition with maximumAge 0) — it does not navigate.
              A failed fix surfaces the ACTIONABLE reason (permission blocked,
              no signal, timeout) instead of a forever-spinning "locating…". */}
          <button
            onClick={onRequestLocation}
            className={`px-2.5 py-1 rounded border transition-all cursor-pointer max-w-[340px] ${
              userLocation
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                : geoError
                  ? "bg-red-500/20 text-red-300 border-red-500/40"
                  : "bg-amber-500/20 text-amber-400 border-amber-500/30"
            }`}
            title={geoError || (isArabic ? "حالة تحديد الموقع — اضغط لإعادة تحديد الموقع الآن" : "État de la localisation — cliquer pour réacquérir la position")}
            aria-label={isArabic ? "إعادة تحديد الموقع الحالي" : "Réacquérir la position actuelle"}
          >
            {userLocation
              ? (isArabic ? "🌐 GPS حقيقي: " : "🌐 GPS Réel : ") + `${userLocation.lat.toFixed(3)}, ${userLocation.lng.toFixed(3)}`
              : geoError
                ? "⚠️ " + geoError
                : (isArabic ? "📍 جاري تحديد الموقع..." : "📍 Localisation GPS...")}
          </button>

          {/* Location-sharing consent (PII audit): the heartbeat NEVER runs
              without explicit opt-in; this toggle is the visible control. */}
          <button
            onClick={() => onToggleLocationConsent(!locationSharingConsent)}
            className={`px-2.5 py-1 rounded border transition-all cursor-pointer ${
              locationSharingConsent
                ? "bg-sky-500/20 text-sky-300 border-sky-500/30"
                : "bg-black/55 text-slate-300 border-white/10"
            }`}
            title={
              isArabic
                ? "مشاركة موقعك مع المرصد (نبض الموقع) — موافقة صريحة مطلوبة، ويمكنك إلغاؤها في أي وقت."
                : "Partage de votre position avec l'observatoire (flux de localisation) — consentement explicite requis, révocable à tout moment."
            }
            aria-pressed={locationSharingConsent}
          >
            {locationSharingConsent
              ? (isArabic ? "📡 مشاركة الموقع: مفعّلة" : "📡 Partage de position : activé")
              : (isArabic ? "📡 مشاركة الموقع: مُعطّلة" : "📡 Partage de position : désactivé")}
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
