import { DatasetKey, FailureReason } from "./datasetHealth";

/**
 * Dataset validation layer: "the endpoint answered 200 with JSON" is NOT a
 * successful dataset. Each source must also match its documented shape before
 * `useObservatoryData` commits it (and before the header can call it Live).
 *
 * Contract:
 * - not an array   -> DatasetValidationError (schema)
 * - empty array    -> valid (an observatory with no data is fine)
 * - any malformed item -> the WHOLE dataset fails; the previous state is kept,
 *   so an invalid payload can never wipe live reports/SOS from the UI.
 */
export class DatasetValidationError extends Error {
  constructor(public readonly key: string) {
    super(`dataset "${key}" failed schema validation`);
    this.name = "DatasetValidationError";
  }
}

export interface DatasetOutcome {
  ok: boolean;
  reason: FailureReason;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function assertList(data: unknown, key: DatasetKey, isItem: (item: unknown) => boolean): unknown[] {
  if (!Array.isArray(data)) throw new DatasetValidationError(key);
  for (const item of data) {
    if (!isItem(item)) throw new DatasetValidationError(key);
  }
  return data;
}

// Geo-critical invariants: identity + finite coordinates. Optional metadata
// (names, images, badge codes...) is not required here — missing optional
// fields degrade display, not safety; malformed geometry does.
const isReportItem = (item: unknown): boolean =>
  isRecord(item) && isNonEmptyString(item.id) && isFiniteNumber(item.lat) && isFiniteNumber(item.lng);

const isSatelliteItem = (item: unknown): boolean =>
  isRecord(item) && isNonEmptyString(item.id) && isFiniteNumber(item.lat) && isFiniteNumber(item.lng);

const isSosItem = (item: unknown): boolean =>
  isRecord(item) && isNonEmptyString(item.id) && isFiniteNumber(item.lat) && isFiniteNumber(item.lng);

const isWilayaItem = (item: unknown): boolean =>
  isRecord(item) && isNonEmptyString(item.nameAr) && isNonEmptyString(item.nameFr);

const isNotificationItem = (item: unknown): boolean =>
  isRecord(item) &&
  isNonEmptyString(item.id) &&
  isNonEmptyString(item.titleAr) &&
  isNonEmptyString(item.titleFr) &&
  typeof item.read === "boolean";

export function validateDataset(key: DatasetKey, data: unknown): unknown[] {
  switch (key) {
    case "reports":
      return assertList(data, key, isReportItem);
    case "satellites":
      return assertList(data, key, isSatelliteItem);
    case "wilayas":
      return assertList(data, key, isWilayaItem);
    case "sos":
      return assertList(data, key, isSosItem);
    case "notifications":
      return assertList(data, key, isNotificationItem);
  }
}