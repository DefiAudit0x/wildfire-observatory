import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRetry } from "../utils/api";
import { getDeviceId } from "../utils/device";

export function useGeolocation(isArabic: boolean) {
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const deviceId = getDeviceId();
  // Monotonic sequence for one-shot refetches: only the LATEST refetch may
  // write location/error state — a slow earlier response can never overwrite
  // a newer one (rapid GPS button presses).
  const refetchSeqRef = useRef(0);
  // Freshness key shared by BOTH writers (watch callbacks and one-shot
  // refetches): positions carry a device timestamp, and only the newest one
  // wins — an old watch fix can never clobber a fresh refetch and vice versa.
  const lastFixTsRef = useRef(0);
  // Latest fix, decoupled from render state: the heartbeat reads this so GPS
  // chatter only refreshes the value — it never tears down the interval.
  const locationRef = useRef<{ lat: number; lng: number } | null>(null);

  const acceptFix = useCallback((pos: GeolocationPosition) => {
    if (pos.timestamp < lastFixTsRef.current) return; // stale fix — newer one already owns the position
    lastFixTsRef.current = pos.timestamp;
    locationRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    setUserLocation(locationRef.current);
    setGeoError(null);
  }, []);

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
          setGeoError(isArabic ? "تعذّر تحديد موقعك. فعّل GPS للتبليغ الدقيق." : "Localisation GPS indisponible. Activez le GPS pour un signalement précis.");
        },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 }
      );
      return () => navigator.geolocation.clearWatch(watchId);
    } else {
      setGeoError(isArabic ? "المتصفح لا يدعم تحديد الموقع." : "Le navigateur ne supporte pas la géolocalisation.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isArabic]);

  // Explicit one-shot location request (the GPS button's real action): asks
  // the browser for a FRESH fix now (maximumAge 0), unlike the passive watch.
  // Stale responses are dropped via refetchSeqRef; the previous error message
  // is cleared as the attempt begins.
  const refetch = useCallback(() => {
    const seq = ++refetchSeqRef.current;
    setGeoError(null);
    if (!navigator.geolocation) {
      setGeoError(isArabic ? "المتصفح لا يدعم تحديد الموقع." : "Le navigateur ne supporte pas la géolocalisation.");
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
        setGeoError(isArabic ? "تعذّر تحديد موقعك. فعّل GPS للتبليغ الدقيق." : "Localisation GPS indisponible. Activez le GPS pour un signalement précis.");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  }, [isArabic, acceptFix]);

  // Location heartbeat: shares the user's fix with the observatory backend
  // (used by coordination features once the device actually has a position).
  // ONE interval lives for the whole session (deps = [deviceId] only): GPS
  // updates refresh locationRef instead of recreating the effect, so the
  // beat is every 30 s regardless of how chatty the position receiver is.
  useEffect(() => {
    const sendHeartbeat = () => {
      const loc = locationRef.current;
      if (!loc) return;
      const storedBadge = localStorage.getItem("reporterBadgeCode") || "";
      const storedName = localStorage.getItem("userName") || "مستخدم مباشر";

      fetchWithRetry("/api/location/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          lat: loc.lat,
          lng: loc.lng,
          name: storedName,
          badgeCode: storedBadge,
        }),
      }).catch(() => {});
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000);
    return () => clearInterval(interval);
  }, [deviceId]);

  return { userLocation, geoError, refetch };
}