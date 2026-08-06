import { useEffect, useRef, useState } from "react";
import { Report } from "../types";
import { haversineKm } from "../utils/geo";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export function useProximityAlerts(reports: Report[], userLocation: GeoPoint | null) {
  const [activeAlerts, setActiveAlerts] = useState<any[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastAlertedReportIdsRef = useRef<Set<string>>(new Set());

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
        .map((rep) => {
          const dist = getProximityDistance(userLocation.lat, userLocation.lng, rep.lat, rep.lng);
          return { ...rep, distance: dist };
        })
        .filter((rep) => rep.distance <= 30) // Within 30km radius
        .sort((a, b) => a.distance - b.distance);

      setActiveAlerts(nearReports);

      // Web Audio sound alerts — only when a NEW report enters the proximity zone
      if (nearReports.length > 0 && !isMuted) {
        const nearIds = new Set(nearReports.map((r) => r.id));
        const newlyEntered = Array.from(nearIds).some((id) => !lastAlertedReportIdsRef.current.has(id));
        if (newlyEntered) {
          lastAlertedReportIdsRef.current = new Set(Array.from(nearIds));
          try {
            if (!audioCtxRef.current) {
              audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            }
            const audioCtx = audioCtxRef.current;
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
            setTimeout(() => {
              if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
                audioCtxRef.current.close().catch(() => {});
                audioCtxRef.current = null;
              }
            }, 2000);
          } catch (err) {
            console.warn("Audio feedback blocked or uninitialized in sandbox context.", err);
          }
        }
      } else {
        lastAlertedReportIdsRef.current = new Set();
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
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const audioCtx = audioCtxRef.current;
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
      setTimeout(() => {
        if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
          audioCtxRef.current.close().catch(() => {});
          audioCtxRef.current = null;
        }
      }, 2000);
    } catch (err) {
      console.warn("Critical alert tone blocked:", err);
    }
  }, [reports, isMuted]);

  return { activeAlerts, isMuted, setIsMuted, getProximityDistance };
}