// Fix 36 (PROX-1): a queued operator tone must not ring after the user
// mutes, and muting must POSTPONE (never swallow) the alert — unmuting
// re-announces the postponed batch. Also covers the D9 sibling: the siren
// must not ring when the user mutes during AudioContext.resume().
// Plain renderHook (no StrictMode option): StrictMode's simulated unmount
// bumps the epoch and clears the throttle timer, which would interfere with
// the timer assertions.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useProximityAlerts, MUTE_STORAGE_KEY } from "../../src/hooks/useProximityAlerts";
import type { Report } from "../../src/types";

function mkReport(id: string, over: Record<string, unknown> = {}): Report {
  return {
    id,
    lat: 36.805,
    lng: 7.605,
    locationName: `موقع ${id}`,
    wilaya: "عنابة",
    description: "حريق",
    severity: "critical",
    status: "pending",
    timestamp: new Date().toISOString(),
    consensusCount: 1,
    ...over,
  } as Report;
}

const userLocation = { lat: 36.8, lng: 7.6 };

// Counts oscillator starts across both channels. The operator beep creates 3
// oscillators per tone, the siren 2 — the tests below isolate one channel at
// a time (pending reports for the operator channel, verified + untrusted for
// the siren), so the count measures only that channel.
let oscStarts = 0;
function installAudioStub(opts: { suspended?: boolean; deferredResume?: { resolve: () => void } | null } = {}) {
  oscStarts = 0;
  class FakeAudioContext {
    state: string = opts.suspended ? "suspended" : "running";
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => {
      if (opts.deferredResume) {
        await new Promise<void>((resolve) => {
          opts.deferredResume!.resolve = resolve;
        });
      }
      this.state = "running";
    });
    createOscillator = () => ({
      type: "",
      frequency: { setValueAtTime: () => {} },
      connect: () => {},
      start: () => {
        oscStarts += 1;
      },
      stop: () => {},
    });
    createGain = () => ({
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
    });
    close = vi.fn(async () => {
      this.state = "closed";
    });
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("webkitAudioContext", FakeAudioContext);
}

describe("useProximityAlerts mute (Fix 36 — PROX-1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.removeItem(MUTE_STORAGE_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a queued operator tone is silenced by muting", async () => {
    installAudioStub();
    const { result, rerender } = renderHook(
      ({ reports }: { reports: Report[] }) => useProximityAlerts(reports, userLocation, true),
      { initialProps: { reports: [mkReport("r1")] } }
    );
    // First critical report: the tone plays immediately (3 osc starts).
    await act(async () => {});
    expect(oscStarts).toBe(3);
    // Second critical report arrives inside the 20 s throttle: queued, with
    // a flush timer scheduled — the tone must NOT play yet.
    rerender({ reports: [mkReport("r1"), mkReport("r2")] });
    await act(async () => {});
    expect(oscStarts).toBe(3);
    // Mute while the batch is queued, then let the throttle expire.
    await act(async () => {
      result.current.setIsMuted(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(oscStarts).toBe(3);
  });

  it("unmuting announces the postponed batch — mute postpones, never swallows", async () => {
    installAudioStub();
    const { result, rerender } = renderHook(
      ({ reports }: { reports: Report[] }) => useProximityAlerts(reports, userLocation, true),
      { initialProps: { reports: [mkReport("r1")] } }
    );
    await act(async () => {});
    expect(oscStarts).toBe(3);
    rerender({ reports: [mkReport("r1"), mkReport("r2")] });
    await act(async () => {});
    await act(async () => {
      result.current.setIsMuted(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(oscStarts).toBe(3);
    // Unmute: the postponed report was never recorded as announced, so the
    // effect re-detects it and the tone plays. (Guard, not discriminator:
    // on old code this passes too — the pending batch survives mute there —
    // it exists so a fix that wrongly swallows the batch fails here.)
    await act(async () => {
      result.current.setIsMuted(false);
    });
    await act(async () => {});
    expect(oscStarts).toBe(6);
  });

  it("the siren does not ring when muting during AudioContext.resume()", async () => {
    const deferredResume: { resolve: () => void } = { resolve: () => {} };
    installAudioStub({ suspended: true, deferredResume });
    const { result } = renderHook(() =>
      useProximityAlerts([mkReport("r1", { status: "verified" })], userLocation, false)
    );
    // The siren scan is parked inside resume() (the stub only resolves when
    // the test releases it). Mute while it is pending.
    await act(async () => {});
    expect(oscStarts).toBe(0);
    await act(async () => {
      result.current.setIsMuted(true);
    });
    await act(async () => {
      deferredResume.resolve();
    });
    await act(async () => {});
    expect(oscStarts).toBe(0);
  });
});
