// @vitest-environment jsdom
/**
 * Fix 30 (HDR-1): the header's reachability badge is a present-tense claim
 * and must consult freshness + the composite sync — a contact from hours
 * ago, or a contact followed by total failure, must not read as
 * "reachable now". The historical "اتصال:" timestamp stays untouched (it
 * is the honest record, not the bug).
 *
 * HeaderBar is memo-wrapped and uses ResizeObserver (jsdom has none) plus
 * a 30 s nowTick interval — stub the observer, freeze the clock, and drive
 * the interval with fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import HeaderBar from "../../src/components/layout/HeaderBar";
import type { DatasetHealth, DatasetKey } from "../../src/utils/datasetHealth";
import { DATASET_KEYS } from "../../src/utils/datasetHealth";

const NOW = new Date("2026-11-23T12:00:00Z").getTime();
const TWO_HOURS = 2 * 60 * 60 * 1000;

function mkHealth(overrides: Partial<Record<DatasetKey, DatasetHealth>> = {}): Record<DatasetKey, DatasetHealth> {
  const base = {} as Record<DatasetKey, DatasetHealth>;
  for (const k of DATASET_KEYS) base[k] = { lastSuccess: NOW - 30_000, lastAttemptOk: true };
  return { ...base, ...overrides };
}

/** Every dataset stale + every latest attempt failed → sync "offline". */
function allFailed(): Record<DatasetKey, DatasetHealth> {
  const base = {} as Record<DatasetKey, DatasetHealth>;
  for (const k of DATASET_KEYS) base[k] = { lastSuccess: NOW - TWO_HOURS, lastAttemptOk: false };
  return base;
}

function renderHeader(lastBackendContact: number, datasetHealth: Record<DatasetKey, DatasetHealth>) {
  return render(
    <HeaderBar
      isArabic
      lang="ar"
      notifications={[]}
      lastRefreshed={NOW}
      lastBackendContact={lastBackendContact}
      datasetHealth={datasetHealth}
      loading={false}
      meshStatus="online"
      meshNodeCount={1}
      onToggleLang={() => {}}
      onRefresh={() => {}}
      onMarkRead={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HeaderBar reachability badge (Fix 30 HDR-1)", () => {
  it("a contact from 2 hours ago does not read as reachable", () => {
    renderHeader(NOW - TWO_HOURS, allFailed());
    expect(screen.getByText("الخادم غير متاح")).toBeTruthy();
    expect(screen.queryByText("الخادم متاح")).toBeNull();
  });

  it("an offline sync inside the window does not read as reachable", () => {
    // Contact 30 s ago, but every dataset's latest attempt failed — the
    // finding's named case: historical contact + sync offline.
    renderHeader(NOW - 30_000, allFailed());
    expect(screen.getByText("الخادم غير متاح")).toBeTruthy();
    expect(screen.queryByText("الخادم متاح")).toBeNull();
  });

  it("a fresh contact with all datasets live reads as reachable (control)", () => {
    renderHeader(NOW - 30_000, mkHealth());
    expect(screen.getByText("الخادم متاح")).toBeTruthy();
    expect(screen.queryByText("الخادم غير متاح")).toBeNull();
  });

  it("a contact exactly 3 minutes old still reads as reachable (boundary)", () => {
    renderHeader(NOW - 3 * 60_000, mkHealth());
    expect(screen.getByText("الخادم متاح")).toBeTruthy();
  });

  it("a contact 3 minutes and 1 ms old reads as unreachable (boundary)", () => {
    renderHeader(NOW - 3 * 60_000 - 1, mkHealth());
    expect(screen.getByText("الخادم غير متاح")).toBeTruthy();
  });

  it("the badge flips to unreachable when the contact ages past 3 minutes", async () => {
    renderHeader(NOW - 179_000, mkHealth());
    expect(screen.getByText("الخادم متاح")).toBeTruthy();
    // The header re-evaluates every 30 s via nowTick — no new poll needed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(screen.getByText("الخادم غير متاح")).toBeTruthy();
  });

  it("the historical last-contact timestamp still renders when sync is not live (control)", () => {
    renderHeader(NOW - TWO_HOURS, allFailed());
    // The timestamp is the honest record — the fix must not remove it.
    expect(screen.getByText(/اتصال:/)).toBeTruthy();
  });
});
