import { useCallback, useEffect, useRef, useState } from "react";
import { Report } from "../types";
import { haversineKm } from "../utils/geo";
import { isFreshThreatTimestamp } from "../utils/threats";

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
 * not when it stays put. The comparison is against the last ANNOUNCED
 * severity — a downgrade (critical→high) never rewrites the memory, so
 * returning to a previously announced level does NOT re-alert. Unknown/new
 * severities are treated as an alert on first sighting.
 */
export function isEscalation(previous?: string, next?: string): boolean {
  if (!next) return false;
  if (!previous) return true; // first sighting
  return (SEVERITY_RANK[previous] ?? -1) < (SEVERITY_RANK[next] ?? -1);
}

export interface SeverityAware {
  id: string;
  severity: string;
}

/**
 * The set of reports that currently warrant an announcement: every report
 * whose severity ESCALATES beyond what the channel already announced (or
 * whose first sighting has no history at all). Reports that stayed the same,
 * dropped, or returned to a previously announced level are excluded.
 */
export function computeNewAlerts(
  announced: ReadonlyMap<string, string>,
  current: SeverityAware[]
): SeverityAware[] {
  return current.filter((r) => isEscalation(announced.get(r.id), r.severity));
}

/**
 * The observatory's ONE alert-eligibility policy (audit): every alert channel
 * answers "may this report ring?" from a single named authority instead of
 * scattered status filters — the previous per-channel filters silently
 * admitted PENDING reports to the citizen siren, contradicting the UI's
 * "بلاغات المواطنين الموثقة فقط" (verified reports only) copy.
 *   - proximity-siren (citizen channel): VERIFIED reports only. Pending
 *     reports may be crowd noise; the citizen-facing siren only rings on
 *     reports that reached the validation step.
 *   - operator-tone (staff/volunteer channel): verified + pending with
 *     high/critical severity (severity gated by the operator effect itself).
 *     Staff acts on the EARLIEST signal — a single critical sighting already
 *     warrants dispatch, so pending is admissible there by policy, not by
 *     omission.
 */
export type AlertChannel = "proximity-siren" | "operator-tone";

export function isReportEligibleForAlert(
  r: Pick<Report, "status">,
  channel: AlertChannel
): boolean {
  if (channel === "proximity-siren") return r.status === "verified";
  return r.status === "verified" || r.status === "pending";
}

export type ReportSeverity = Report["severity"];

const PROXIMITY_THRESHOLDS: Record<ReportSeverity, number> = {
  critical: 10, // km
  high: 7,
  medium: 5,
  low: 3,
};

export function getProximityThreshold(severity: string): number | undefined {
  return severity in PROXIMITY_THRESHOLDS
    ? PROXIMITY_THRESHOLDS[severity as ReportSeverity]
    : undefined;
}

export async function commitOperatorBatchAfterTone(
  playTone: () => Promise<boolean>,
  isTrusted: () => boolean,
  getEpoch: () => number,
  startEpoch: number,
  commit: () => void,
): Promise<boolean> {
  const played = await playTone();
  if (!played || !isTrusted() || startEpoch !== getEpoch()) return false;
  commit();
  return true;
}

/** Inter-announcement floor for the operator channel (command-center tone). */
const OPERATOR_BEEP_THROTTLE_MS = 20000;

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
  // Alert memory: report id → last ANNOUNCED severity (never the last
  // observed one — see computeNewAlerts). Kept for the whole session: a
  // transiently empty zone never resets it, so the same report re-entering
  // its zone is not announced twice, while a severity ESCALATION
  // (high→critical) always is. A downgrade never rewrites the memory, so
  // returning to an announced level is NOT a fresh alert.
  const lastAlertedReportIdsRef = useRef<Map<string, string>>(new Map());
  // Operator channel: alerts DETECTED but not yet ANNOUNCED (throttle or
  // timer pending). Separation of detected vs announced is what makes the
  // 20 s floor a postponement, never a swallowed alert.
  const operatorPendingRef = useRef<Map<string, string>>(new Map());
  const operatorFlushTimerRef = useRef<number | null>(null);
  const lastOperatorBeepAtRef = useRef(0);
  const proximityScanInFlightRef = useRef(false);
  const trustedReporterRef = useRef(isTrustedReporter);
  trustedReporterRef.current = isTrustedReporter;
  const operatorFlushEpochRef = useRef(0);
  const operatorFlushInFlightRef = useRef(false);

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

  const beepOperatorTone = useCallback(async (hasCritical: boolean): Promise<boolean> => {
    try {
      if (!operatorAudioCtxRef.current) {
        operatorAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const audioCtx = operatorAudioCtxRef.current;
      if (audioCtx.state === "suspended") await audioCtx.resume();
      if (!trustedReporterRef.current) return false;
      if (audioCtx.state !== "running") throw new Error("AudioContext is not running");
      const t0 = audioCtx.currentTime;
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
      return true;
    } catch (err) {
      console.warn("Critical alert tone blocked:", err);
      return false;
    }
  }, []);

  // Flush the operator pending queue: announce what was DETECTED but held
  // back by the throttle. If the 20 s floor has not elapsed, the flush is
  // POSTPONED via a timer (never swallowed); severities that dropped below
  // high/critical meanwhile are dropped from the queue by the main effect.
  const flushOperatorPending = useCallback(async () => {
    if (!trustedReporterRef.current || operatorFlushInFlightRef.current) return;
    const flushEpoch = operatorFlushEpochRef.current;
    const pending = operatorPendingRef.current;
    if (pending.size === 0) return;
    const now = Date.now();
    const remaining = lastOperatorBeepAtRef.current + OPERATOR_BEEP_THROTTLE_MS - now;
    if (remaining > 0) {
      if (operatorFlushTimerRef.current === null) {
        operatorFlushTimerRef.current = window.setTimeout(() => {
          operatorFlushTimerRef.current = null;
          void flushOperatorPending();
        }, remaining + 50);
      }
      return;
    }

    const batch = new Map(pending);
    const hasCritical = [...batch.values()].some((severity) => severity === "critical");
    operatorFlushInFlightRef.current = true;
    let committed = false;
    try {
      committed = await commitOperatorBatchAfterTone(
        () => beepOperatorTone(hasCritical),
        () => trustedReporterRef.current,
        () => operatorFlushEpochRef.current,
        flushEpoch,
        () => {
          const nextMemory = new Map<string, string>(lastCriticalIdsRef.current);
          for (const [id, sev] of batch) nextMemory.set(id, sev);
          lastCriticalIdsRef.current = nextMemory;
          for (const [id, sev] of batch) {
            if (pending.get(id) === sev) pending.delete(id);
          }
          lastOperatorBeepAtRef.current = Date.now();
        },
      );
    } finally {
      operatorFlushInFlightRef.current = false;
    }
    if (!committed) {
      if (operatorFlushTimerRef.current === null) {
        operatorFlushTimerRef.current = window.setTimeout(() => {
          operatorFlushTimerRef.current = null;
          void flushOperatorPending();
        }, 1000);
      }
      return;
    }
    if (pending.size > 0) void flushOperatorPending();
  }, [beepOperatorTone]);

  // Lifecycle cleanup: cancel pending close timers, release any context still
  // open, and drop a scheduled operator flush when the consumer unmounts.
  useEffect(() => {
    return () => {
      operatorFlushEpochRef.current += 1;
      if (proximityCloseTimerRef.current !== null) window.clearTimeout(proximityCloseTimerRef.current);
      if (operatorCloseTimerRef.current !== null) window.clearTimeout(operatorCloseTimerRef.current);
      if (operatorFlushTimerRef.current !== null) window.clearTimeout(operatorFlushTimerRef.current);
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

    const scanProximity = async () => {
      if (proximityScanInFlightRef.current) return;
      // Non-finite coordinates (NaN markers from unresolved server responses)
      // are never measured: NaN distance comparisons are always false, but
      // the invariant is enforced here so no downstream consumer sees one.
      const nearReports = reports
        .filter(
          (rep) =>
            isReportEligibleForAlert(rep, "proximity-siren") &&
            // v1.0.4: SAME freshness authority as the SOS flow / Home banner
            // (isFreshThreatTimestamp from threats.ts). The banner used to
            // announce reports of ANY age — including the server's stale seed
            // rows — while the SOS modal filtered them out: the contradictory
            // "تنبيه قريب منك / لا توجد حرائق نشطة" pair the owner reported.
            isFreshThreatTimestamp(rep.timestamp) &&
            Number.isFinite(rep.lat) &&
            Number.isFinite(rep.lng) &&
            getProximityThreshold(rep.severity) !== undefined
        )
        .map((rep) => {
          const dist = getProximityDistance(userLocation.lat, userLocation.lng, rep.lat, rep.lng);
          const threshold = getProximityThreshold(rep.severity) as number;
          return { ...rep, distance: dist, isNear: dist <= threshold, thresholdKm: threshold };
        })
        .filter((rep) => rep.isNear) // Severity-aware radius
        .sort((a, b) => a.distance - b.distance);

      setActiveAlerts(nearReports);

      if (nearReports.length === 0) return; // keep the alert memory intact

      // While muted we keep the memory UNTOUCHED (it only advances at the
      // moment a report actually announces, below). Unmuting therefore
      // announces only reports with no announcement history — those first
      // detected during the mute window — never the whole existing list.
      if (isMuted) return;

      // Web Audio sound alerts — only when a NEW report enters the proximity
      // zone OR an already-announced one ESCALATES to a higher severity.
      const announced = lastAlertedReportIdsRef.current;
      const newly = computeNewAlerts(announced, nearReports);
      if (newly.length === 0) return; // nothing new: memory stays untouched

      proximityScanInFlightRef.current = true;
      try {
        if (!proximityAudioCtxRef.current) {
          proximityAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        const audioCtx = proximityAudioCtxRef.current;
        if (audioCtx.state === "suspended") await audioCtx.resume();
        if (audioCtx.state !== "running") throw new Error("AudioContext is not running");
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

        const nextMemory = new Map<string, string>(announced);
        for (const a of newly) nextMemory.set(a.id, a.severity);
        lastAlertedReportIdsRef.current = nextMemory;
        closeAudioCtxAfter(proximityCloseTimerRef, proximityAudioCtxRef, 2000);
      } catch (err) {
        console.warn("Audio feedback blocked or uninitialized in sandbox context.", err);
      } finally {
        proximityScanInFlightRef.current = false;
      }
    };

    void scanProximity();
    const alertInterval = setInterval(() => void scanProximity(), 15000);
    return () => clearInterval(alertInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLocation, reports, isMuted]);

  // Operator alert tone when a new critical/high report appears (throttled).
  // Citizens (no trusted badge) never hear this channel: the operator tone
  // is a command-center alert for staff/volunteer devices, and routing it to
  // every citizen phone would wear out the alert. Citizens are served by the
  // proximity siren above, which is location-bound.
  const lastCriticalIdsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!isTrustedReporter) {
      operatorFlushEpochRef.current += 1;
      operatorPendingRef.current.clear();
      if (operatorFlushTimerRef.current !== null) {
        window.clearTimeout(operatorFlushTimerRef.current);
        operatorFlushTimerRef.current = null;
      }
      return;
    }
    const critical = reports.filter(
      (r) =>
        (r.severity === "critical" || r.severity === "high") &&
        isReportEligibleForAlert(r, "operator-tone")
    );
    const announced = lastCriticalIdsRef.current;
    const pending = operatorPendingRef.current;

    // Detected now = escalation against BOTH announced memory and whatever is
    // already pending. Refresh a queued report's severity before flushing so a
    // downgrade cannot retain a stale critical tone.
    for (const id of [...pending.keys()]) {
      const current = critical.find((r) => r.id === id);
      if (!current) pending.delete(id);
      else if (pending.get(id) !== current.severity) pending.set(id, current.severity);
    }
    const newOnes = computeNewAlerts(announced, critical).filter((a) =>
      isEscalation(pending.get(a.id), a.severity)
    );
    if (newOnes.length === 0) return;

    // While muted the alert is NOT recorded anywhere — neither announced nor
    // pending: unmuting re-runs this effect (isMuted is a dep) and announces
    // it then, instead of silently dropping the alert that arrived during
    // the mute.
    if (isMuted) return;

    for (const a of newOnes) pending.set(a.id, a.severity);
    void flushOperatorPending();
  }, [reports, isMuted, isTrustedReporter, flushOperatorPending]);

  return { activeAlerts, isMuted, setIsMuted, getProximityDistance };
}
