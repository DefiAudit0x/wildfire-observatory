import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRetry } from "../utils/api";
import { getDeviceId } from "../utils/device";

/**
 * Human-readable, per-code GPS failure messages. A single generic message
 * hides the actionable difference between "browser lacks the API",
 * "permission revoked", "no signal" and "timeout" — each has a different fix.
 * Pass "unsupported" when navigator.geolocation is absent entirely (the fix
 * is a browser upgrade, not turning GPS on).
 */
export function geoErrorMessage(
  code: number | "unsupported" | undefined,
  isArabic: boolean
): string {
  switch (code) {
    case "unsupported":
      return isArabic
        ? "متصفحك لا يدعم تحديد الموقع الجغرافي — حدّث المتصفح أو استخدم جهازاً حديثاً."
        : "Votre navigateur ne supporte pas la géolocalisation — mettez-le à jour ou utilisez un appareil récent.";
    case 1: // PERMISSION_DENIED
      return isArabic
        ? "إذن الموقع محظور — فعّل إذن الموقع من إعدادات المتصفح."
        : "Autorisation de localisation refusée — activez-la dans les réglages du navigateur.";
    case 2: // POSITION_UNAVAILABLE
      return isArabic
        ? "تعذّر تحديد الموقع — اخرج إلى مساحة مفتوحة وحاول مجدداً."
        : "Position indisponible — placez-vous à découvert et réessayez.";
    case 3: // TIMEOUT
      return isArabic
        ? "انتهت مهلة تحديد الموقع — أعد المحاولة."
        : "Délai de localisation dépassé — réessayez.";
    default:
      return isArabic
        ? "تعذّر تحديد موقعك. فعّل GPS للتبليغ الدقيق."
        : "Localisation GPS indisponible. Activez le GPS pour un signalement précis.";
  }
}

const HEARTBEAT_CONSENT_KEY = "observatory_heartbeat_consent";
const MAX_CLOCK_SKEW_MS = 60_000;

export function useGeolocation(isArabic: boolean) {
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [isLocationStale, setIsLocationStale] = useState(false);
  const [lastFixAt, setLastFixAt] = useState<number | null>(null);
  const [lastFixAccuracy, setLastFixAccuracy] = useState<number | null>(null);
  // Location-sharing consent (PII audit): the heartbeat sends the device's
  // position to the observatory backend continuously. That only happens after
  // the user EXPLICITLY opts in via the UI toggle (default: OFF). Revoking
  // consent stops the beat immediately.
  const [locationSharingConsent, setLocationSharingConsent] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HEARTBEAT_CONSENT_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [deviceId] = useState(() => getDeviceId());
  // Monotonic sequence for one-shot refetches: only the LATEST refetch may
  // write location/error state — a slow earlier response can never overwrite
  // a newer one (rapid GPS button presses).
  const refetchSeqRef = useRef(0);
  // Freshness key shared by BOTH writers (watch callbacks and one-shot
  // refetches): positions carry a device timestamp, and only the newest one
  // wins — an old watch fix can never clobber a fresh refetch and vice versa.
  const lastFixTsRef = useRef(0);
  // Tolerated skew between the device clock and our arrival clock: a device
  // clock far ahead of ours would stamp every fix with a future timestamp and
  // (without clamping) poison lastFixTsRef, blocking all later fixes.
  // Latest fix, decoupled from render state: the heartbeat reads this so GPS
  // chatter only refreshes the value — it never tears down the interval.
  const locationRef = useRef<{ lat: number; lng: number } | null>(null);
  // Language mirror for the watcher effect: the watcher is installed ONCE for
  // the session (deps = []) and reads the CURRENT language from this ref, so
  // a language toggle never tears down the live position watch.
  const isArabicRef = useRef(isArabic);
  isArabicRef.current = isArabic;

  const acceptFix = useCallback((pos: GeolocationPosition) => {
    // A broken provider may emit NaN coordinates (audit): non-finite fixes
    // are discarded BEFORE touching locationRef, so no consumer (proximity
    // scan, heartbeat, report form) can ever see one.
    if (
      !Number.isFinite(pos.coords.latitude) ||
      !Number.isFinite(pos.coords.longitude)
    ) {
      console.warn("Discarding non-finite geolocation fix");
      return;
    }
    // Ordering key: the device timestamp is used for the stale-vs-fresh
    // comparison, but it lives in the DEVICE's clock domain — an absurd
    // future stamp (clock skew) is clamped to arrival time so a skewed clock
    // can never reject every subsequent fix. Arrival order remains the
    // tiebreaker for fixes the device reports as simultaneous.
    const arrivedAt = Date.now();
    const ts =
      Number.isFinite(pos.timestamp) && pos.timestamp <= arrivedAt + MAX_CLOCK_SKEW_MS
        ? pos.timestamp
        : arrivedAt;
    if (ts < lastFixTsRef.current) return; // stale fix — newer one already owns the position
    lastFixTsRef.current = ts;
    locationRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    setUserLocation(locationRef.current);
    setGeoError(null);
    setIsLocating(false);
    setIsLocationStale(false);
    setLastFixAt(arrivedAt);
    setLastFixAccuracy(Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null);
  }, []);

  // The watch is installed exactly ONCE (empty deps): it never re-creates on
  // language change, so a fix that arrives mid-toggle cannot be lost. The
  // error wording reads the language mirror instead.
  useEffect(() => {
    if (navigator.geolocation) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          acceptFix(pos);
        },
        (err) => {
          // GPS-loss decision (documented): a lost fix does NOT wipe the last
          // known position — a transient blip would silently remove a correct
          // location from an in-flight report. The error is surfaced instead
          // and the form can still submit the last fix, visibly flagged.
          console.warn("Geolocation error:", err);
          setIsLocating(false);
          setIsLocationStale(Boolean(locationRef.current));
          setGeoError(geoErrorMessage(err?.code, isArabicRef.current));
        },
        // maximumAge bounds the age of a fix the browser may REPLAY from its
        // cache at acquisition time — it is NOT a guarantee that the alert
        // pipeline always consumes fresh positions: while the receiver has no
        // new fix, the last known position stays the (documented, intended)
        // value consumed by proximity/beacon. The comment must not overclaim.
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
      );
      return () => navigator.geolocation.clearWatch(watchId);
    } else {
      setGeoError(geoErrorMessage("unsupported", isArabicRef.current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptFix]);

  // Explicit one-shot location request (the GPS button's real action): asks
  // the browser for a FRESH fix now (maximumAge 0), unlike the passive watch.
  // Stale responses are dropped via refetchSeqRef; the previous error message
  // is cleared as the attempt begins.
  const refetch = useCallback(() => {
    const seq = ++refetchSeqRef.current;
    setIsLocating(true);
    setGeoError(null);
    if (!navigator.geolocation) {
      setIsLocating(false);
      setIsLocationStale(Boolean(locationRef.current));
      setGeoError(geoErrorMessage("unsupported", isArabic));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (seq !== refetchSeqRef.current) return;
        acceptFix(pos);
      },
      (err) => {
        if (seq !== refetchSeqRef.current) return;
        console.warn("Geolocation refresh error:", err);
        setIsLocating(false);
        setIsLocationStale(Boolean(locationRef.current));
        setGeoError(geoErrorMessage(err?.code, isArabic));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  }, [isArabic, acceptFix]);

  // Explicit consent (PII audit): the heartbeat only ever runs when the user
  // opted in — see locationSharingConsent. The beat carries deviceId +
  // coordinates only; the display name is NOT sent (the server resolves the
  // operator name from the badge code, or shows "غير معروف"), and badgeCode
  // only travels when one is stored, for server-side role resolution.
  const setLocationConsent = useCallback((granted: boolean) => {
    setLocationSharingConsent(granted);
    try {
      if (granted) localStorage.setItem(HEARTBEAT_CONSENT_KEY, "true");
      else localStorage.removeItem(HEARTBEAT_CONSENT_KEY);
    } catch {
      // storage unavailable — consent holds for this session only
    }
  }, []);

  // Location heartbeat: shares the user's fix with the observatory backend
  // (used by coordination features once the device actually has a position).
  // ONE interval lives for the whole session (deps = [deviceId, consent]
  // only): GPS updates refresh locationRef instead of recreating the effect,
  // so the beat is every 30 s regardless of how chatty the position receiver
  // is. Revoking consent clears the interval on the spot.
  useEffect(() => {
    if (!locationSharingConsent) return;
    const sendHeartbeat = () => {
      const loc = locationRef.current;
      if (!loc) return;
      let storedBadge: string | undefined;
      try {
        storedBadge = localStorage.getItem("reporterBadgeCode") || undefined;
      } catch {
        storedBadge = undefined;
      }

      fetchWithRetry("/api/location/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          lat: loc.lat,
          lng: loc.lng,
          ...(storedBadge ? { badgeCode: storedBadge } : {}),
        }),
      }).catch(() => {});
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000);
    return () => clearInterval(interval);
  }, [deviceId, locationSharingConsent]);

  return {
    userLocation,
    geoError,
    isLocating,
    isLocationStale,
    lastFixAt,
    lastFixAccuracy,
    refetch,
    locationSharingConsent,
    setLocationConsent,
  };
}
