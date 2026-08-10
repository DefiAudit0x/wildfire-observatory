/**
 * Composite source-health model for the observatory header.
 *
 * The observatory is FIVE datasets (reports, satellites, wilayas, SOS,
 * notifications), not one boolean. Each endpoint reports its own freshness;
 * the composite state is derived so the UI can never claim "Live" when only
 * one source answered, nor "Offline" when the backend is merely partial.
 */
export type DatasetKey = "reports" | "satellites" | "wilayas" | "sos" | "notifications";

export interface DatasetHealth {
  /** Epoch ms of the last time THIS dataset passed transport + JSON + schema
   *  validation (null = never). A response that does NOT match the dataset
   *  shape is NOT a success: see FailureReason. */
  lastSuccess: number | null;
  /** Whether the latest poll attempt for THIS dataset succeeded end-to-end. */
  lastAttemptOk: boolean;
  /** Why the latest attempt failed when lastAttemptOk is false. */
  lastFailureReason?: FailureReason;
}

/** Why a dataset attempt failed — lets the UI distinguish "network down",
 *  "server error", "unparsable body" and "structurally invalid payload". */
export type FailureReason = "transport" | "http" | "parse" | "schema";

export const DATASET_KEYS: DatasetKey[] = ["reports", "satellites", "wilayas", "sos", "notifications"];

/** A dataset is "stale" once its last success is older than this. */
export const STALE_AFTER_MS = 3 * 60_000;

/** How often the header re-evaluates freshness without re-rendering the app. */
export const NOW_TICK_MS = 30_000;

export type DatasetState = "live" | "degraded" | "stale" | "never";
export type SyncState = "live" | "partial" | "degraded" | "stale" | "offline" | "never";

function deriveState(h: DatasetHealth, now: number): DatasetState {
  if (h.lastSuccess === null) return "never";
  if (now - h.lastSuccess > STALE_AFTER_MS) return "stale";
  return h.lastAttemptOk ? "live" : "degraded";
}

export function computeSyncState(
  health: Record<DatasetKey, DatasetHealth>,
  now: number
): { states: Record<DatasetKey, DatasetState>; sync: SyncState } {
  const states = {} as Record<DatasetKey, DatasetState>;
  for (const key of DATASET_KEYS) states[key] = deriveState(health[key], now);

  const has = (s: DatasetState) => DATASET_KEYS.some((k) => states[k] === s);
  const all = (s: DatasetState) => DATASET_KEYS.every((k) => states[k] === s);
  const allAttemptsFailed = DATASET_KEYS.every((k) => health[k].lastAttemptOk === false);

  let sync: SyncState;
  if (all("live")) sync = "live";
  else if (has("live")) sync = "partial";
  else if (has("degraded")) sync = "degraded";
  else if (allAttemptsFailed) sync = "offline";
  else if (has("stale")) sync = "stale";
  else sync = "never";

  return { states, sync };
}