import { useEffect, useRef, useState } from "react";
import { Report } from "../types";
import { haversineKm } from "../utils/geo";

export interface GeoPoint {
  lat: number;
  lng: number;
}

const PROXIMITY_THRESHOLDS: Record<string, number> = {
  critical: 10, // km
  high: 7,
  medium: 5,
  low: 3,
};

export function useProximityAlerts(reports: Report[], userLocation: GeoPoint | null) {
  const [activeAlerts, setActiveAlerts] = useState<any[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  // Two independent alert channels (proximity siren vs operator tone) each own
  // their AudioContext, so one route's 2s close timer can never close the
  // context the other route just opened.
  const proximityAudioCtxRef = useRef<AudioContext | null>(null);
  const operatorAudioCtxRef = useRef<AudioContext | null>(null);
  const lastAlertedReportIdsRef = useRef<Set<string>>(new Set());

  const closeAudioCtxAfter = (ref: { current: AudioContext | null }, ms: number) => {
    setTimeout(() => {
      if (ref.current && ref.current.state !== "closed") {
        ref.current.close().catch(() => {});
        ref.current = null;
      }
    }, ms);
  };

  const getProximityDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number =>
    haversineKm(lat1, lng1, lat2, lng2);

  // Recurrent scanning loop for proximity fires (checks reports list every 15 seconds)
  useEffect(() => {
    if (!userLocation || reports.length === 0) {
      setActiveAlerts([]);
      return;
    }

    const scanProximity = () => {
      const nearReports = reports
        .filter((rep) => rep.status !== "resolved" && rep.status !== "rejected")
        .map((rep) => {
          const dist = getProximityDistance(userLocation.lat, userLocation.lng, rep.lat, rep.lng);
          const threshold = PROXIMITY_THRESHOLDS[rep.severity] ?? 5;
          return { ...rep, distance: dist, isNear: dist <= threshold };
        })
        .filter((rep) => rep.isNear) // Severity-aware radius
        .sort((a, b) => a.distance - b.distance);

      setActiveAlerts(nearReports);

      if (nearReports.length === 0) {
        // Zone empty: forget the boarded set so the next arrival alerts.
        lastAlertedReportIdsRef.current = new Set();
        return;
      }

      const nearIds = new Set(nearReports.map((r) => r.id));

      // While muted we only RECORD the current set (without touching the
      // already-recorded one): unmuting must never replay the whole existing
      // list — only reports that entered the zone during the mute window.
      if (isMuted) return;

      // Web Audio sound alerts — only when a NEW report enters the proximity zone
      const newlyEntered = Array.from(nearIds).some((id) => !lastAlertedReportIdsRef.current.has(id));
      if (newlyEntered) {
        lastAlertedReportIdsRef.current = new Set(Array.from(nearIds));
        try {
          if (!proximityAudioCtxRef.current) {
            proximityAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
          }
          const audioCtx = proximityAudioCtxRef.current;
          const osc1 = audioCtx.createOscillator();
          const osc2 = audioCtx.createOscillator();
          const gainNode = audioCtx.createGain();

          osc1.type = "sine";
          osc1.frequency.setValueAtTime(880, audioCtx.currentTime);

          osc2.type = "sawtooth";
          osc2.frequency.setValueAtTime(440, audioCtx.currentTime);

          gainNode.gain.setValueAtTime(0.04, audioCtx.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.0);

          osc1.connect(gainNode);
          osc2.connect(gainNode);
          gainNode.connect(audioCtx.destination);

          osc1.start();
          osc2.start();

          osc1.stop(audioCtx.currentTime + 1.0);
          osc2.stop(audioCtx.currentTime + 1.0);
          closeAudioCtxAfter(proximityAudioCtxRef, 2000);
        } catch (err) {
          console.warn("Audio feedback blocked or uninitialized in sandbox context.", err);
        }
      }
    };

    scanProximity();
    const alertInterval = setInterval(scanProximity, 15000);
    return () => clearInterval(alertInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLocation, reports, isMuted]);

  // Operator alert tone when a new critical/high report appears (throttled)
  const lastCriticalIdsRef = useRef<Set<string>>(new Set());
  const lastBeepAtRef = useRef(0);
  useEffect(() => {
    const critical = reports.filter(
      (r) =>
        (r.severity === "critical" || r.severity === "high") &&
        r.status !== "resolved" &&
        r.status !== "rejected"
    );
    const seen = lastCriticalIdsRef.current;
    const newOnes = critical.filter((r) => !seen.has(r.id));
    for (const r of newOnes) seen.add(r.id);
    if (newOnes.length === 0 || isMuted) return;
    const now = Date.now();
    if (now - lastBeepAtRef.current < 20000) return;
    lastBeepAtRef.current = now;
    try {
      if (!operatorAudioCtxRef.current) {
        operatorAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const audioCtx = operatorAudioCtxRef.current;
      const t0 = audioCtx.currentTime;
      const hasCritical = newOnes.some((x) => x.severity === "critical");
      for (let i = 0; i < 3; i++) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(hasCritical ? 1200 : 900, t0 + i * 0.35);
        gain.gain.setValueAtTime(0.05, t0 + i * 0.35);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.35 + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0 + i * 0.35);
        osc.stop(t0 + i * 0.35 + 0.3);
      }
      closeAudioCtxAfter(operatorAudioCtxRef, 2000);
    } catch (err) {
      console.warn("Critical alert tone blocked:", err);
    }
  }, [reports, isMuted]);

  return { activeAlerts, isMuted, setIsMuted, getProximityDistance };
}