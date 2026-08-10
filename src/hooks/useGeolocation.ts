import { useCallback, useEffect, useState } from "react";
import { fetchWithRetry } from "../utils/api";
import { getDeviceId } from "../utils/device";

export function useGeolocation(isArabic: boolean) {
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const deviceId = getDeviceId();

  useEffect(() => {
    if (navigator.geolocation) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setGeoError(null);
        },
        (err) => {
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
  const refetch = useCallback(() => {
    if (!navigator.geolocation) {
      setGeoError(isArabic ? "المتصفح لا يدعم تحديد الموقع." : "Le navigateur ne supporte pas la géolocalisation.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoError(null);
      },
      (err) => {
        console.warn("Geolocation refresh error:", err);
        setGeoError(isArabic ? "تعذّر تحديد موقعك. فعّل GPS للتبليغ الدقيق." : "Localisation GPS indisponible. Activez le GPS pour un signalement précis.");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  }, [isArabic]);

  // Heartbeat: send user location to server for Central Command tracking
  useEffect(() => {
    if (!userLocation) return;

    const sendHeartbeat = () => {
      const storedBadge = localStorage.getItem("reporterBadgeCode") || "";
      const storedName = localStorage.getItem("userName") || "مستخدم مباشر";

      fetchWithRetry("/api/location/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          lat: userLocation.lat,
          lng: userLocation.lng,
          name: storedName,
          badgeCode: storedBadge,
        }),
      }).catch(() => {});
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000);
    return () => clearInterval(interval);
  }, [userLocation, deviceId]);

  return { userLocation, geoError, refetch };
}