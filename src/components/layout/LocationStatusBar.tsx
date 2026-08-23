import { memo, useEffect, useState } from "react";
import { GeoPoint } from "../../hooks/useProximityAlerts";

interface LocationStatusBarProps {
  isArabic: boolean;
  userLocation: GeoPoint | null;
  /** Actionable GPS failure (permission/coverage/timeout/unsupported) from useGeolocation. */
  geoError: string | null;
  isLocating: boolean;
  isLocationStale: boolean;
  lastFixAt: number | null;
  lastFixAccuracy: number | null;
  /** Fires a one-shot FRESH geolocation request (the GPS button's real action). */
  onRequestLocation: () => void;
  /** Location-sharing consent for the heartbeat (PII audit). */
  locationSharingConsent: boolean;
  onToggleLocationConsent: (granted: boolean) => void;
}

/**
 * ALWAYS-VISIBLE location surface (audit): the consent toggle and the GPS
 * state previously lived inside ProximityAlertBar, which only renders while
 * alerts are active — so with an empty alert zone the user could neither
 * revoke consent (contradicting the copy "يمكنك إلغاؤها في أي وقت") nor see
 * a GPS failure. This bar is unconditional: consent stays revocable at any
 * moment and geoErrors stay surfaced even with zero active alerts.
 */
function LocationStatusBar({
  isArabic,
  userLocation,
  geoError,
  isLocating,
  isLocationStale,
  lastFixAt,
  lastFixAccuracy,
  onRequestLocation,
  locationSharingConsent,
  onToggleLocationConsent,
}: LocationStatusBarProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="bg-black/70 border-b border-white/10 text-slate-300 px-4 py-1.5 md:px-8 z-[1000]">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-1.5 text-[10px] font-bold">
        {/* GPS status indicator: clicking re-requests a FRESH location fix
            (getCurrentPosition with maximumAge 0) — it does not navigate.
            A failed fix surfaces the ACTIONABLE reason (permission blocked,
            no signal, timeout) instead of a forever-spinning "locating…". */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={onRequestLocation}
            disabled={isLocating}
            className={`px-2.5 py-1 rounded border transition-all cursor-pointer max-w-[340px] truncate ${
              userLocation && !isLocationStale
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                : geoError
                  ? "bg-red-500/20 text-red-300 border-red-500/40"
                  : "bg-amber-500/20 text-amber-400 border-amber-500/30"
            } ${isLocating ? "opacity-70 cursor-wait" : ""}`}
            title={geoError || (isArabic ? "حالة تحديد الموقع — اضغط لإعادة تحديد الموقع الآن" : "État de la localisation — cliquer pour réacquérir la position")}
            aria-label={isArabic ? "إعادة تحديد الموقع الحالي" : "Réacquérir la position actuelle"}
          >
            {isLocating
              ? (isArabic ? "📍 جاري تحديث الموقع..." : "📍 Actualisation GPS...")
              : userLocation
                ? (isLocationStale
                  ? (isArabic ? "⚠️ آخر موقع معروف: " : "⚠️ Dernière position connue : ")
                  : (isArabic ? "🌐 GPS حقيقي: " : "🌐 GPS Réel : ")) + `${userLocation.lat.toFixed(3)}, ${userLocation.lng.toFixed(3)}`
                : geoError
                  ? "⚠️ " + geoError
                  : (isArabic ? "📍 جاري تحديد الموقع..." : "📍 Localisation GPS...")}
          </button>
          {(userLocation && lastFixAt) && (
            <span className={isLocationStale ? "text-amber-300" : "text-slate-500"}>
              {isLocationStale
                ? (isArabic ? "إشارة GPS مفقودة" : "Signal GPS perdu")
                : `${isArabic ? "تحديث" : "Fix"} ${Math.max(0, Math.round((now - lastFixAt) / 1000))}s${lastFixAccuracy !== null ? ` · ±${Math.round(lastFixAccuracy)}m` : ""}`}
            </span>
          )}

          {/* Location-sharing consent (PII audit): the heartbeat NEVER runs
              without explicit opt-in; this toggle — always visible, so it can
              be revoked at any moment, not just while alerts are showing —
              is the visible control. */}
          <button
            onClick={() => onToggleLocationConsent(!locationSharingConsent)}
            className={`px-2.5 py-1 rounded border transition-all cursor-pointer ${
              locationSharingConsent
                ? "bg-sky-500/20 text-sky-300 border-sky-500/30"
                : "bg-black/55 text-slate-300 border-white/10"
            }`}
            title={
              isArabic
                ? "مشاركة موقعك مع المرصد: تتيح هذه الموافقة إرسال نبض موقع دوري (كل 30 ثانية) طالما التطبيق مفتوح — وليس لبلاغ واحد فقط — مع إمكانية إلغائها في أي وقت من هذا الزر."
                : "Partage de position avec l'observatoire : ce consentement autorise un flux périodique (toutes les 30 s) tant que l'application est ouverte — pas seulement pour un signalement — révocable à tout moment via ce bouton."
            }
            aria-pressed={locationSharingConsent}
          >
            {locationSharingConsent
              ? (isArabic ? "📡 مشاركة الموقع: مفعّلة" : "📡 Partage de position : activé")
              : (isArabic ? "📡 مشاركة الموقع: مُعطّلة" : "📡 Partage de position : désactivé")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(LocationStatusBar);
