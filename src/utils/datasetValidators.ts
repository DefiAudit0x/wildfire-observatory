import type { Report, SatelliteHotspot, TrappedSOS, WilayaStatus, Notification } from "../types";
import { DatasetKey, FailureReason } from "./datasetHealth";

/**
 * Dataset validation layer: "the endpoint answered 200 with JSON" is NOT a
 * successful dataset. Each source must also match its documented shape before
 * `useObservatoryData` commits it (and before the header can call it Live).
 *
 * The item predicates here are ALSO the runtime gate for the non-poll writers
 * (POST response, confirm response, mesh messages): every entry point that
 * feeds reports/SOS state must pass the same rules as the GET poll.
 *
 * Contract:
 * - not an array   -> DatasetValidationError (schema)
 * - empty array    -> valid (an observatory with no data is fine)
 * - any malformed item -> the WHOLE dataset fails; the previous state is kept,
 *   so an invalid payload can never wipe live reports/SOS from the UI.
 */
export type ValidationFailure = "not-array" | "malformed-item";

export class DatasetValidationError extends Error {
  constructor(
    public readonly key: string,
    public readonly reason: ValidationFailure
  ) {
    super(`dataset "${key}" failed schema validation (${reason})`);
    this.name = "DatasetValidationError";
  }
}

export interface DatasetOutcome {
  ok: boolean;
  reason: FailureReason;
}

export const REPORT_STATUSES = ["pending", "verified", "rejected", "resolved"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type ReportSeverity = (typeof REPORT_SEVERITIES)[number];
export const SOS_STATUSES = ["active", "resolved"] as const;
export const SATELLITE_TYPES = ["MODIS", "VIIRS", "MODIS/VIIRS", "VIIRS/MODIS"] as const;
export const WILAYA_SEVERITIES = ["safe", "low", "medium", "high", "critical"] as const;
export const NOTIFICATION_TYPES = ["success", "warning", "error", "info"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// A timestamp must actually PARSE as a date — "متفرغ", "now" or "0000-00-00"
// are not timestamps. The mesh relay contract and the server both emit ISO
// 8601; anything Date.parse cannot read fails the source.
const isIsoTimestamp = (v: unknown): v is string =>
  isNonEmptyString(v) && !Number.isNaN(Date.parse(v));

// Geo-critical invariants: finite AND inside the physical bounds. 999,-999 is
// a finite number but not a point on Earth; these datasets feed proximity,
// distance, map and evacuation logic, so impossible geometry fails the source.
const isLatitude = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
const isLongitude = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;
const isNonNegativeNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
// Counts must be whole numbers: consensusCount/activeFires are counters, and
// the mesh confirm contract (Number.isInteger) must not contradict the poll.
const isIntegerCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000;

const isValidAiVerification = (v: unknown): boolean =>
  isRecord(v) &&
  typeof v.isVerified === "boolean" &&
  typeof v.confidence === "number" && Number.isFinite(v.confidence) && v.confidence >= 0 && v.confidence <= 100 &&
  Array.isArray(v.detectedSigns) && v.detectedSigns.every((sign) => isNonEmptyString(sign)) &&
  typeof v.aiComments === "string" &&
  isNonEmptyString(v.suggestedSeverity);

const isOneOf = <T extends string>(allowed: readonly T[]) => (v: unknown): v is T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v);

const isReportStatus = isOneOf(REPORT_STATUSES);
const isReportSeverity = isOneOf(REPORT_SEVERITIES);
const isSosStatus = isOneOf(SOS_STATUSES);
const isSatelliteType = isOneOf(SATELLITE_TYPES);
const isWilayaSeverity = isOneOf(WILAYA_SEVERITIES);
const isNotificationType = isOneOf(NOTIFICATION_TYPES);

/**
 * Report wire contract — the fields the app DEPENDS on (map, stats, proximity,
 * scheduler, confirmations). These are present on every payload the server
 * actually emits; a payload missing any of them is not a report.
 */
export const isValidReport = (v: unknown): v is Report =>
  isRecord(v) &&
  isNonEmptyString(v.id) &&
  isLatitude(v.lat) &&
  isLongitude(v.lng) &&
  isNonEmptyString(v.locationName) &&
  isNonEmptyString(v.wilaya) &&
  isNonEmptyString(v.description) &&
  isReportSeverity(v.severity) &&
  isReportStatus(v.status) &&
  isIsoTimestamp(v.timestamp) &&
  isIntegerCount(v.consensusCount) &&
  (v.aiVerification === undefined || isValidAiVerification(v.aiVerification));

/**
 * Satellite hotspot contract: the identity/location fields are not enough —
 * brightness/confidence/scanTime/satellite/wilaya define what a hotspot IS.
 */
export const isValidSatelliteItem = (v: unknown): v is SatelliteHotspot =>
  isRecord(v) &&
  isNonEmptyString(v.id) &&
  isLatitude(v.lat) &&
  isLongitude(v.lng) &&
  isNonNegativeNumber(v.brightness) &&
  typeof v.confidence === "number" &&
  Number.isFinite(v.confidence) &&
  v.confidence >= 0 &&
  v.confidence <= 100 &&
  isNonEmptyString(v.scanTime) &&
  isIsoTimestamp(v.scanTime) &&
  isSatelliteType(v.satellite) &&
  isNonEmptyString(v.wilaya);

/** SOS contract: status is required — a stateless SOS can never count as active. */
export const isValidSosItem = (v: unknown): v is TrappedSOS =>
  isRecord(v) &&
  isNonEmptyString(v.id) &&
  isLatitude(v.lat) &&
  isLongitude(v.lng) &&
  isSosStatus(v.status) &&
  isIsoTimestamp(v.timestamp);

export const isValidWilayaItem = (v: unknown): v is WilayaStatus =>
  isRecord(v) &&
  isNonEmptyString(v.nameAr) &&
  isNonEmptyString(v.nameFr) &&
  isIntegerCount(v.activeFires) &&
  isIntegerCount(v.satelliteHotspots) &&
  isWilayaSeverity(v.severity) &&
  typeof v.evacuationRecommended === "boolean" &&
  isNonEmptyString(v.emergencyPhone);

export const isValidNotificationItem = (v: unknown): v is Notification =>
  isRecord(v) &&
  isNonEmptyString(v.id) &&
  isNonEmptyString(v.deviceId) &&
  isNonEmptyString(v.titleAr) &&
  isNonEmptyString(v.titleFr) &&
  isNonEmptyString(v.bodyAr) &&
  isNonEmptyString(v.bodyFr) &&
  isNotificationType(v.type) &&
  isIsoTimestamp(v.timestamp) &&
  typeof v.read === "boolean";

function assertList(data: unknown, key: DatasetKey, isItem: (item: unknown) => boolean): unknown[] {
  if (!Array.isArray(data)) throw new DatasetValidationError(key, "not-array");
  for (const item of data) {
    if (!isItem(item)) throw new DatasetValidationError(key, "malformed-item");
  }
  return data;
}

export function validateDataset(key: DatasetKey, data: unknown): unknown[] {
  switch (key) {
    case "reports":
      return assertList(data, key, isValidReport);
    case "satellites":
      return assertList(data, key, isValidSatelliteItem);
    case "wilayas":
      return assertList(data, key, isValidWilayaItem);
    case "sos":
      return assertList(data, key, isValidSosItem);
    case "notifications":
      return assertList(data, key, isValidNotificationItem);
  }
}
