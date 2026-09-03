import { useEffect, useRef, useState } from "react";
import { isFreshThreatTimestamp } from "../../utils/threats";
import { calculateBearing, getDistanceKm, safeAlignmentAccuracyValue } from "./reportFormShared";

/**
 * ARC-H13 — THE owner of the field-camera concern: the getUserMedia lifecycle
 * (reentrancy guard + unmount release — ARC-H12), the throttled compass
 * sensor listener (ARC-M20: 4Hz + rounded-dedupe, the form never fabricates a
 * heading/pitch), the manual slider overrides, the honest camera-unavailable
 * status, and the visual correlation of the framed bearing against nearby
 * fresh reports (an alignment ESTIMATE — 15km / 45° FOV gate, scored
 * angle+distance, surfaced as 40-95%).
 */
export interface UseReportCameraParams {
  lat: string;
  lng: string;
  reports: any[];
  isArabic: boolean;
  setErrorMsg: (message: string | null) => void;
}

export function useReportCamera({ lat, lng, reports, isArabic, setErrorMsg }: UseReportCameraParams) {
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<"closed" | "active" | "unavailable">("closed");
  const [stream, setStream] = useState<MediaStream | null>(null);
  // Sensor values are null until a real sensor delivers them — the form never
  // fabricates a heading/pitch (no fake compass numbers stamped on photos).
  const [heading, setHeading] = useState<number | null>(null); // 0-360 degrees (compass bearing)
  const [pitch, setPitch] = useState<number | null>(null); // -90 to 90 degrees (elevation angle)
  const [headingSource, setHeadingSource] = useState<"sensor" | "manual" | "none">("none");
  const [pitchSource, setPitchSource] = useState<"sensor" | "manual" | "none">("none");
  const [matchedReport, setMatchedReport] = useState<any | null>(null);
  const [alignmentAccuracy, setAlignmentAccuracy] = useState<number | null>(null);
  const [showCalibrationGuide, setShowCalibrationGuide] = useState(false);
  const [includeTelemetry, setIncludeTelemetry] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);

  // Listener for actual device orientation/compass sensors
  // ARC-M20 fix: this listener fed setState directly from every sensor event
  // (phones fire up to 60Hz with sub-degree jitter), re-rendering the entire
  // ~1900-line component continuously. Updates are now throttled to 4Hz AND
  // skipped when the rounded values did not change.
  useEffect(() => {
    const lastCompassValuesRef = { heading: null as number | null, pitch: null as number | null };
    let lastUpdateAt = 0;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      const now = Date.now();
      if (now - lastUpdateAt < 250) return;

      let currentHeading = null;
      if ("webkitCompassHeading" in e) {
        currentHeading = (e as any).webkitCompassHeading;
      } else if (e.alpha !== null) {
        // 360 - alpha is only an approximation of the compass bearing (device
        // orientation vs. geographic north); it is treated as an estimate.
        currentHeading = 360 - e.alpha;
      }

      const roundedHeading = currentHeading !== null ? Math.round(currentHeading) : null;
      const roundedPitch = e.beta !== null ? Math.round(e.beta) : null;
      if (roundedHeading === lastCompassValuesRef.heading && roundedPitch === lastCompassValuesRef.pitch) {
        return;
      }
      lastUpdateAt = now;
      lastCompassValuesRef.heading = roundedHeading;
      lastCompassValuesRef.pitch = roundedPitch;

      if (roundedHeading !== null) {
        setHeading(roundedHeading);
        setHeadingSource("sensor");
      }
      if (roundedPitch !== null) {
        setPitch(roundedPitch);
        setPitchSource("sensor");
      }
    };

    window.addEventListener("deviceorientation", handleOrientation);
    return () => {
      window.removeEventListener("deviceorientation", handleOrientation);
    };
  }, []);

  // Correlation effect: matches GPS + compass heading with current reports
  // (an alignment estimate only — no bearing, no matching).
  useEffect(() => {
    if (!lat || !lng || heading === null || !reports || reports.length === 0) {
      setMatchedReport(null);
      setAlignmentAccuracy(null);
      return;
    }

    const uLat = parseFloat(lat);
    const uLng = parseFloat(lng);
    if (isNaN(uLat) || isNaN(uLng)) return;

    let bestMatch: any = null;
    let maxScore = -1;

    reports.forEach((rep) => {
      if ((rep.status !== "pending" && rep.status !== "verified") || !isFreshThreatTimestamp(rep.timestamp) || !Number.isFinite(rep.lat) || !Number.isFinite(rep.lng)) return;
      const dist = getDistanceKm(uLat, uLng, rep.lat, rep.lng);
      // Correlate reports within 15km
      if (dist > 15) return;

      const bearing = calculateBearing(uLat, uLng, rep.lat, rep.lng);
      let diff = Math.abs(bearing - heading);
      if (diff > 180) diff = 360 - diff;

      // Only match if within 45 degrees of camera focus FOV
      if (diff > 45) return;

      // Score based on angular alignment and distance proximity
      const angleScore = ((45 - diff) / 45) * 60; // Up to 60 points
      const distScore = ((15 - dist) / 15) * 40;  // Up to 40 points
      const score = angleScore + distScore;

      if (score > maxScore) {
        maxScore = score;
        bestMatch = {
          report: rep,
          distance: dist,
          bearing: bearing,
          angleDiff: diff,
        };
      }
    });

    if (bestMatch) {
      setMatchedReport(bestMatch.report);
      const confidence = Math.round(40 + (maxScore / 100) * 55); // 40% to 95%
      setAlignmentAccuracy(confidence);
    } else {
      setMatchedReport(null);
      setAlignmentAccuracy(null);
    }
  }, [lat, lng, heading, reports]);

  const safeAlignmentAccuracy = safeAlignmentAccuracyValue(alignmentAccuracy);
  const safeMatchedDistance = matchedReport && Number.isFinite(Number(matchedReport.distance))
    ? Number(matchedReport.distance).toFixed(1)
    : "—";
  const safeMatchedBearing = matchedReport && Number.isFinite(Number(matchedReport.bearing))
    ? Number(matchedReport.bearing).toFixed(0)
    : "—";

  // Attach the media stream to the <video> the moment it exists — no arbitrary
  // delay that races the element mount.
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // ARC-H12 fix: this component is conditionally mounted (tab switches unmount
  // it) — without this cleanup an open camera stream kept the device camera
  // hardware live with NO UI attached to it. When the stream changes or the
  // component unmounts, the tracks are stopped.
  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [stream]);

  // Camera stream activation
  // ARC-H12 fix: a double-tap on the camera button used to race two
  // getUserMedia calls — the first stream was overwritten by the second and
  // leaked live (privacy). A reentrancy guard plus an unmount cleanup effect
  // guarantee the hardware is released exactly once.
  const cameraStartingRef = useRef(false);
  const startCamera = async () => {
    if (cameraStartingRef.current || stream) return;
    cameraStartingRef.current = true;
    try {
      setIsCameraOpen(true);
      setCameraStatus("closed");
      setErrorMsg(null);
      const constraints = {
        video: { facingMode: "environment" },
        audio: false,
      };
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(mediaStream);
      setCameraStatus("active");
      // iOS (Safari 13+) gates motion sensors behind an explicit permission
      // prompt; request it within the camera gesture.
      try {
        const DOE = (window as any).DeviceOrientationEvent;
        if (DOE && typeof DOE.requestPermission === "function") {
          const permission = await DOE.requestPermission();
          if (permission !== "granted") {
            setHeading(null);
            setPitch(null);
            setHeadingSource(permission === "denied" ? "none" : headingSource);
            setPitchSource("none");
          }
        }
      } catch (err) {
        console.warn("DeviceOrientation permission request failed", err);
      }
    } catch (err: unknown) {
      console.warn("Camera hardware unavailable", err);
      setCameraStatus("unavailable");
      setStream(null);
      setIsCameraOpen(false);
      setErrorMsg(isArabic ? "الكاميرا غير متاحة أو لم يُسمح لها. يمكنك إرفاق صورة من جهازك أو متابعة البلاغ بدون صورة." : "Caméra indisponible ou permission refusée. Vous pouvez joindre une photo ou continuer sans image.");
    } finally {
      cameraStartingRef.current = false;
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    setIsCameraOpen(false);
    setCameraStatus("closed");
    setHeading(null);
    setPitch(null);
    setHeadingSource("none");
    setPitchSource("none");
    setMatchedReport(null);
    setAlignmentAccuracy(null);
    setShowCalibrationGuide(false);
  };

  // Reset applied after an accepted submission (ported verbatim from the
  // original success path — the camera UI state itself is NOT touched here).
  const resetOrientation = () => {
    setHeading(null);
    setPitch(null);
    setPitchSource("none");
    setHeadingSource("none");
    setMatchedReport(null);
    setAlignmentAccuracy(null);
  };

  const setManualHeading = (value: number) => {
    setHeading(value);
    setHeadingSource("manual");
  };
  const setManualPitch = (value: number) => {
    setPitch(value);
    setPitchSource("manual");
  };

  return {
    isCameraOpen,
    cameraStatus,
    stream,
    videoRef,
    heading,
    pitch,
    headingSource,
    pitchSource,
    matchedReport,
    alignmentAccuracy,
    showCalibrationGuide, setShowCalibrationGuide,
    includeTelemetry, setIncludeTelemetry,
    safeAlignmentAccuracy,
    safeMatchedDistance,
    safeMatchedBearing,
    startCamera,
    stopCamera,
    resetOrientation,
    setManualHeading,
    setManualPitch,
  };
}
