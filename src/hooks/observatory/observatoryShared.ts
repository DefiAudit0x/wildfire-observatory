import type { Report } from "../../types";
import type { DatasetHealth, DatasetKey, FailureReason } from "../../utils/datasetHealth";

/**
 * ARC-H4 decomposition — shared vocabulary for the observatory hook family.
 * The former 775-line useObservatoryData god-hook fused ~9 concerns; these
 * modules split them while keeping ONE owner per state slice:
 *
 *   observatoryShared        — types/constants + the timed fetch primitive
 *   observatoryPendingReport — pure local-pending-report coercion
 *   observatoryMeshBroadcast — pure mesh fan-out (allow-list + bounds gate)
 *   observatoryUpload        — pure multipart form building
 *   useObservatoryPoll       — THE owner of the five dataset states, the
 *                              cycle guard, health, spinner and cadence
 *   useMeshSync              — mesh client lifecycle + gossip ingestion
 *   useReportSubmission      — POST /api/reports (transport vs rejection)
 *   useReportConfirmation    — principal enrollment + consensus confirm
 *   useObservatoryData       — thin orchestrator, unchanged public surface
 */

/** Result of one dataset attempt: valid payload carried for real data. */
export interface DatasetAttempt {
  ok: boolean;
  reason?: FailureReason;
  data?: unknown[];
}

export const EMPTY_DATASET_HEALTH: Record<DatasetKey, DatasetHealth> = {
  reports: { lastSuccess: null, lastAttemptOk: false },
  satellites: { lastSuccess: null, lastAttemptOk: false },
  wilayas: { lastSuccess: null, lastAttemptOk: false },
  sos: { lastSuccess: null, lastAttemptOk: false },
  notifications: { lastSuccess: null, lastAttemptOk: false },
};

export interface FetchOutcome {
  /** True when the state the observatory now holds contains pending/verified reports or active SOS. */
  hasActiveActivity: boolean;
  /** Every dataset answered OK in this poll. */
  allOk: boolean;
  /** At least one dataset answered OK in this poll (backend reachable). */
  anyOk: boolean;
}

export const EMPTY_OUTCOME: FetchOutcome = { hasActiveActivity: false, allOk: false, anyOk: false };

/**
 * Hard ceiling for every poll request (audit): a raw fetch() with no timeout
 * can stall forever, which would (a) hang the polling loop — scheduleNext
 * never re-arms — and (b) keep the spinner up indefinitely. An aborted
 * request settles as a "transport" failure: a settled outcome, never a hang.
 */
export const FETCH_TIMEOUT_MS = 15000;

export function fetchWithTimeout(url: string, signal?: AbortSignal, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return fetch(url, { ...init, signal: combinedSignal });
}

/**
 * Fields ReportForm sends for a citizen report. The image may be a data URL
 * (multipart path) or absent; coordinates may arrive as strings from the form.
 * severity/reporterType are REAL unions (not loose strings): the compile-time
 * type only helps call sites — the runtime guard in buildLocalPendingReport
 * is what actually protects the schema from values like "nuclear".
 */
export interface CitizenReportPayload {
  lat: number | string;
  lng: number | string;
  locationName: string;
  wilaya: string;
  description: string;
  severity?: Report["severity"];
  reporterName?: string;
  reporterPhone?: string;
  reporterType?: "citizen" | "volunteer" | "official";
  reporterBadgeCode?: string;
  clientGeneratedId?: string;
  image?: string;
}
