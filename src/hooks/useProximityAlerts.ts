import { useEffect, useRef, useState } from "react";
import { Report } from "../types";
import { haversineKm } from "../utils/geo";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface ProximityAlert extends Report {
  distance: number;
  isNear: boolean;
  /** The severity-aware radius (km) that admitted this report into the zone. */
  thresholdKm: number;
}

/** Monotonic severity ordering: LOW < MEDIUM < HIGH < CRITICAL. */
export const SEVERITY_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Alert escalation rule shared by every alert channel (proximity siren and
 * operator tone): a report re-alerts when its severity RISES (high→critical),
 * not when it stays put. Unknown/new severities are treated as an alert.
 */
export function isEscalation(previous?: string, next?: string): boolean {
  if (!next) return false;
  if (!previous) return true; // first sighting
  return (SEVERITY_RANK[previous] ?? -1) < (SEVERITY_RANK[next] ?? -1);
}

const PROXIMITY_THRESHOLDS: Record<string, number> = {
  critical: 10, // km
  high: 7,
  medium: 5,
  low: 3,
};

export const MUTE_STORAGE_KEY = "observatory_proximity_muted";

export function useProximityAlerts(
  reports: Report[],
  userLocation: GeoPoint | null,
  /** Trusted reporters (staff/volunteer with a badge) get the operator tone;
   *  citizens get the proximity siren only. */
  isTrustedReporter = false
) {
  const [activeAlerts, setActiveAlerts] = useState<ProximityAlert[]>([]);
  // Mute persists across reloads (its own key, read on mount): a citizen who
  // muted the siren in the field must not be startled by a restored page.
  const [isMuted, setIsMuted] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MUTE_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  // Keep the stored flag in sync with the live state (best-effort; storage
  // unavailability only costs the session-scoped value).
  useEffect(() => {
    try {
      if (isMuted) localStorage.setItem(MUTE_STORAGE_KEY, "true");
      else localStorage.removeItem(MUTE_STORAGE_KEY);
    } catch {
      // storage unavailable — mute holds for this session only
    }
  }, [isMuted]);
  // Two independent alert channels (proximity siren vs operator tone) each own
  // their AudioContext, so one route's close timer can never close the context
  // the other route just opened. Each route ALSO owns ONE close timer that is
  // re-armed on reuse — a stale timer can no longer close a context that a
  // newer alert (same route) is still ringing.
  const proximityAudioCtxRef = useRef<AudioContext | null>(null);
  const operatorAudioCtxRef = useRef<AudioContext | null>(null);
  const proximityCloseTimerRef = useRef<number | null>(null);
  const operatorCloseTimerRef = useRef<number | null>(null);
  // Alert memory: report id → last ANNOUNCED severity. Kept for the whole
  // session — a transiently empty zone (one bad poll, GPS blip) never resets
  // it, so the same report re-entering its zone is not announced twice, while
  // a severity ESCALATION (high→critical) is always announced.
  const lastAlertedReportIdsRef = useRef<Map<string, string>>(new Map());

  const closeAudioCtxAfter = (
    timerRef: { current: number | null },
    ref: { current: AudioContext | null },
    ms: number
  ) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (ref.current && ref.current.state !== "closed") {
        ref.current.close().catch(() => {});
        ref.current = null;
      }
    }, ms);
  };

  // Lifecycle cleanup: cancel pending close timers and release any context
  // still open when the consumer unmounts.
  useEffect(() => {
    return () => {
      if (proximityCloseTimerRef.current !== null) window.clearTimeout(proximityCloseTimerRef.current);
      if (operatorCloseTimerRef.current !== null) window.clearTimeout(operatorCloseTimerRef.current);
      proximityAudioCtxRef.current?.close().catch(() => {});
      operatorAudioCtxRef.current?.close().catch(() => {});
      proximityAudioCtxRef.current = null;
      operatorAudioCtxRef.current = null;
    };
  }, []);

  const getProximityDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number =>
    haversineKm(lat1, lng1, lat2, lng2);

  // Recurrent scanning loop for proximity fires (checks reports list every 15 seconds)
  useEffect(() => {
    if (!userLocation || reports.length === 0) {
      // GPS lost or the list emptied: the HUD clears, but the alert memory is
      // preserved (see lastAlertedReportIdsRef) — transient emptiness must
      // not cause a re-announcement storm when data returns.
      setActiveAlerts([]);
      return;
    }

    const scanProximity = () => {
      const nearReports = reports
        .filter((rep) => rep.status !== "resolved" && rep.status !== "rejected")
        .map((rep) => {
          const dist = getProximityDistance(userLocation.lat, userLocation.lng, rep.lat, rep.lng);
          const threshold = PROXIMITY_THRESHOLDS[rep.severity] ?? 5;
          return { ...rep, distance: dist, isNear: dist <= threshold, thresholdKm: threshold };
        })
        .filter((rep) => rep.isNear) // Severity-aware radius
        .sort((a, b) => a.distance - b.distance);

      setActiveAlerts(nearReports);

      if (nearReports.length === 0) return; // keep the alert memory intact

      // While muted we only RECORD the current set (without touching the
      // already-recorded one): unmuting must never replay the whole existing
      // list — only reports that entered the zone during the mute window.
      if (isMuted) return;

      // Web Audio sound alerts — only when a NEW report enters the proximity
      // zone OR an already-announced one ESCALATES to a higher severity.
      const announced = lastAlertedReportIdsRef.current;
      const newlyEntered = nearReports.some((rep) =>
        isEscalation(announced.get(rep.id), rep.severity)
      );
      if (newlyEntered) {
        const nextMemory = new Map<string, string>(announced);
        for (const rep of nearReports) nextMemory.set(rep.id, rep.severity);
        lastAlertedReportIdsRef.current = nextMemory;
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
          // Autoplay policies may leave the context suspended: resume before
          // the scheduled starts so the siren actually rings.
          if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
          closeAudioCtxAfter(proximityCloseTimerRef, proximityAudioCtxRef, 2000);
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

  // Operator alert tone when a new critical/high report appears (throttled).
  // Citizens (no trusted badge) never hear this channel: the operator tone
  // is a command-center alert for staff/volunteer devices, and routing it to
  // every citizen phone would wear out the alert. Citizens are served by the
  // proximity siren above, which is location-bound.
  const lastCriticalIdsRef = useRef<Map<string, string>>(new Map());
  const lastBeepAtRef = useRef(0);
  useEffect(() => {
    if (!isTrustedReporter) return;
    const critical = reports.filter(
      (r) =>
        (r.severity === "critical" || r.severity === "high") &&
        r.status !== "resolved" &&
        r.status !== "rejected"
    );
    const seen = lastCriticalIdsRef.current;
    // A report re-announces when its severity RISES (high→critical) too.
    const newOnes = critical.filter((r) => isEscalation(seen.get(r.id), r.severity));
    if (newOnes.length === 0) return;
    // While muted the report is NOT recorded as "already announced": unmuting
    // then announces it, instead of silently dropping the alert it arrived
    // during.
    if (isMuted) return;
    const nextMemory = new Map<string, string>(seen);
    for (const r of newOnes) nextMemory.set(r.id, r.severity);
    lastCriticalIdsRef.current = nextMemory;
    const now = Date.now();
    if (now - lastBeepAtRef.current < 20000) return;
    lastBeepAtRef.current = now;
    try {
      if (!operatorAudioCtxRef.current) {
        operatorAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const audioCtx = operatorAudioCtxRef.current;
      if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
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
      closeAudioCtxAfter(operatorCloseTimerRef, operatorAudioCtxRef, 2000);
    } catch (err) {
      console.warn("Critical alert tone blocked:", err);
    }
  }, [reports, isMuted, isTrustedReporter]);

  return { activeAlerts, isMuted, setIsMuted, getProximityDistance };
}
