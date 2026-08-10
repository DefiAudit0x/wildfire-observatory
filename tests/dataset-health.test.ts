import { describe, it, expect } from "vitest";
import { computeSyncState, DatasetHealth, DatasetKey } from "../src/utils/datasetHealth.js";

const NOW = Date.now();

function health(over: Partial<Record<DatasetKey, Partial<DatasetHealth>>>): Record<DatasetKey, DatasetHealth> {
  const base: Record<DatasetKey, DatasetHealth> = {
    reports: { lastSuccess: NOW, lastAttemptOk: true },
    satellites: { lastSuccess: NOW, lastAttemptOk: true },
    wilayas: { lastSuccess: NOW, lastAttemptOk: true },
    sos: { lastSuccess: NOW, lastAttemptOk: true },
    notifications: { lastSuccess: NOW, lastAttemptOk: true },
  };
  for (const key of Object.keys(over) as DatasetKey[]) {
    if (over[key] && over[key]!.lastSuccess !== undefined) base[key].lastSuccess = over[key]!.lastSuccess!;
    if (over[key] && over[key]!.lastAttemptOk !== undefined) base[key].lastAttemptOk = over[key]!.lastAttemptOk!;
  }
  return base;
}

const FIVE_MIN_AGO = NOW - 5 * 60_000;

describe("computeSyncState", () => {
  it("is Live only when every dataset is fresh and its last attempt succeeded", () => {
    const { sync, states } = computeSyncState(health({}), NOW);
    expect(sync).toBe("live");
    expect(Object.values(states).every((s) => s === "live")).toBe(true);
  });

  it("is Partial (not Live) when a single dataset failed while others succeeded", () => {
    const { sync, states } = computeSyncState(
      health({ satellites: { lastSuccess: NOW - 30_000, lastAttemptOk: false } }),
      NOW
    );
    expect(states.satellites).toBe("degraded");
    expect(sync).toBe("partial");
  });

  it("never claims Live when only one endpoint answered", () => {
    const { sync, states } = computeSyncState(
      health({
        reports: { lastSuccess: NOW, lastAttemptOk: true },
        satellites: { lastSuccess: null, lastAttemptOk: false },
        wilayas: { lastSuccess: null, lastAttemptOk: false },
        sos: { lastSuccess: null, lastAttemptOk: false },
        notifications: { lastSuccess: null, lastAttemptOk: false },
      }),
      NOW
    );
    expect(states.reports).toBe("live");
    expect(sync).toBe("partial");
  });

  it("is Stale when every dataset is older than the freshness window", () => {
    const { sync, states } = computeSyncState(health({
      reports: { lastSuccess: FIVE_MIN_AGO, lastAttemptOk: true },
      satellites: { lastSuccess: FIVE_MIN_AGO, lastAttemptOk: true },
      wilayas: { lastSuccess: FIVE_MIN_AGO, lastAttemptOk: true },
      sos: { lastSuccess: FIVE_MIN_AGO, lastAttemptOk: true },
      notifications: { lastSuccess: FIVE_MIN_AGO, lastAttemptOk: true },
    }), NOW);
    expect(states.reports).toBe("stale");
    expect(sync).toBe("stale");
  });

  it("treats exactly the freshness window as still fresh (boundary: >, not >=)", () => {
    const atBoundary = NOW - 180_000;
    const justPast = NOW - 180_001;
    const { states: at } = computeSyncState(health({
      reports: { lastSuccess: atBoundary, lastAttemptOk: true },
      satellites: { lastSuccess: atBoundary, lastAttemptOk: true },
      wilayas: { lastSuccess: atBoundary, lastAttemptOk: true },
      sos: { lastSuccess: atBoundary, lastAttemptOk: true },
      notifications: { lastSuccess: atBoundary, lastAttemptOk: true },
    }), NOW);
    const { states: past } = computeSyncState(health({
      reports: { lastSuccess: justPast, lastAttemptOk: true },
      satellites: { lastSuccess: justPast, lastAttemptOk: true },
      wilayas: { lastSuccess: justPast, lastAttemptOk: true },
      sos: { lastSuccess: justPast, lastAttemptOk: true },
      notifications: { lastSuccess: justPast, lastAttemptOk: true },
    }), NOW);
    expect(at.reports).toBe("live");
    expect(past.reports).toBe("stale");
  });

  it("reports the failure reason alongside a failed dataset", () => {
    const { states } = computeSyncState(
      health({ satellites: { lastSuccess: NOW - 30_000, lastAttemptOk: false } }),
      NOW
    );
    expect(states.satellites).toBe("degraded");
  });

  it("is Offline only when every dataset failed its last attempt", () => {
    const { sync } = computeSyncState(
      health({
        reports: { lastSuccess: FIVE_MIN_AGO, lastAttemptOk: false },
        satellites: { lastSuccess: FIVE_MIN_AGO, lastAttemptOk: false },
        wilayas: { lastSuccess: FIVE_MIN_AGO, lastAttemptOk: false },
        sos: { lastSuccess: null, lastAttemptOk: false },
        notifications: { lastSuccess: null, lastAttemptOk: false },
      }),
      NOW
    );
    expect(sync).toBe("offline");
  });

  it("is Degraded when no dataset is live but fresh data coexists with failing attempts", () => {
    const { sync } = computeSyncState(
      health({
        reports: { lastSuccess: NOW - 60_000, lastAttemptOk: false },
        satellites: { lastSuccess: NOW - 60_000, lastAttemptOk: false },
        wilayas: { lastSuccess: NOW - 60_000, lastAttemptOk: false },
        sos: { lastSuccess: NOW - 60_000, lastAttemptOk: false },
        notifications: { lastSuccess: NOW - 60_000, lastAttemptOk: false },
      }),
      NOW
    );
    expect(sync).toBe("degraded");
  });

  it("is Sync (never) before the first successful poll", () => {
    const { sync } = computeSyncState(
      health({
        reports: { lastSuccess: null, lastAttemptOk: true },
        satellites: { lastSuccess: null, lastAttemptOk: true },
        wilayas: { lastSuccess: null, lastAttemptOk: true },
        sos: { lastSuccess: null, lastAttemptOk: true },
        notifications: { lastSuccess: null, lastAttemptOk: true },
      }),
      NOW
    );
    expect(sync).toBe("never");
  });
});