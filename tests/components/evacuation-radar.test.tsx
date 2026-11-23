import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import EvacuationRadar from "../../src/components/EvacuationRadar";
import type { Report, SatelliteHotspot } from "../../src/types";

const NOW = new Date("2026-11-23T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function mkReport(over: Record<string, unknown> = {}): Report {
  return {
    id: "r-1",
    lat: 36.81,
    lng: 7.61,
    locationName: "بلاغ اختبار",
    wilaya: "الجزائر - عنابة (Algérie - Annaba)",
    description: "بلاغ اختبار",
    severity: "high",
    status: "pending",
    timestamp: iso(NOW.getTime()),
    consensusCount: 1,
    ...over,
  } as Report;
}

function mkSatellite(over: Record<string, unknown> = {}): SatelliteHotspot {
  return {
    id: "s-1",
    lat: 36.82,
    lng: 7.62,
    confidence: 90,
    brightness: 400,
    scanTime: iso(NOW.getTime()),
    satellite: "VIIRS",
    wilaya: "",
    ...over,
  } as SatelliteHotspot;
}

function windSuccessResponse() {
  return new Response(
    JSON.stringify({
      current: { temperature_2m: 25, wind_speed_10m: 20, wind_direction_10m: 90 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function windFailureResponse() {
  return new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } });
}

describe("EvacuationRadar wind freshness (Fix 25 — RAD-1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a failed refresh past the 10-minute window ages the wind out: the Live badge flips off", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? windSuccessResponse() : windFailureResponse();
      })
    );
    render(
      <EvacuationRadar
        reports={[mkReport({})]}
        satellites={[]}
        userLocation={{ lat: 36.8, lng: 7.6 }}
        lang="ar"
      />
    );
    // One good fetch: the badge reads Live.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("مباشر")).toBeTruthy();
    // The 10-minute interval fires a failing refresh past the window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    });
    expect(screen.getByText("غير متاح")).toBeTruthy();
    // The spread guidance goes quiet with it — no drift heading is shown.
    expect(screen.getByText(/بيانات الرياح الحية غير متاحة؛ لا يتم حساب اتجاه الانتشار\./)).toBeTruthy();
    expect(screen.getByText("البيانات غير متاحة")).toBeTruthy();
  });

  it("a failed refresh exactly at the window edge keeps the last-good wind", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? windSuccessResponse() : windFailureResponse();
      })
    );
    render(<EvacuationRadar reports={[]} satellites={[]} userLocation={{ lat: 36.8, lng: 7.6 }} lang="ar" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("مباشر")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });
    expect(screen.getByText("مباشر")).toBeTruthy();
    expect(screen.queryByText("غير متاح")).toBeNull();
  });
});

describe("EvacuationRadar threat freshness (Fix 25 — RAD-3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", vi.fn(async () => windFailureResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a days-old report and satellite point within 30 km do not determine the closest fire", async () => {
    const stale = iso(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    render(
      <EvacuationRadar
        reports={[mkReport({ timestamp: stale })]}
        satellites={[mkSatellite({ scanTime: stale })]}
        userLocation={{ lat: 36.8, lng: 7.6 }}
        lang="ar"
      />
    );
    expect(screen.getByText("لا توجد أهداف حريق ضمن نطاق 30 كم")).toBeTruthy();
    expect(screen.queryByText("بلاغ قريب ضمن نطاق الرادار")).toBeNull();
  });

  it("a fresh report at the same coordinates does determine the closest fire", async () => {
    render(
      <EvacuationRadar
        reports={[mkReport({})]}
        satellites={[]}
        userLocation={{ lat: 36.8, lng: 7.6 }}
        lang="ar"
      />
    );
    expect(screen.getByText("بلاغ قريب ضمن نطاق الرادار")).toBeTruthy();
  });

  it("a report 5 minutes in the future (beyond the 2-minute skew) is excluded", async () => {
    render(
      <EvacuationRadar
        reports={[mkReport({ timestamp: iso(NOW.getTime() + 5 * 60 * 1000) })]}
        satellites={[]}
        userLocation={{ lat: 36.8, lng: 7.6 }}
        lang="ar"
      />
    );
    expect(screen.getByText("لا توجد أهداف حريق ضمن نطاق 30 كم")).toBeTruthy();
  });

  it("a report 1 minute in the future (within the skew) is included", async () => {
    render(
      <EvacuationRadar
        reports={[mkReport({ timestamp: iso(NOW.getTime() + 1 * 60 * 1000) })]}
        satellites={[]}
        userLocation={{ lat: 36.8, lng: 7.6 }}
        lang="ar"
      />
    );
    expect(screen.getByText("بلاغ قريب ضمن نطاق الرادار")).toBeTruthy();
  });
});
