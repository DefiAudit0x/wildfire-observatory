import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CentralCommand from "../../src/components/CentralCommand";
import type { TrappedSOS } from "../../src/types";
import type { UserLocationData } from "../../src/components/command/StatCards";

// Fix 24 D7: the real CommandMap calls Leaflet's L.map + ResizeObserver in
// an effect, which jsdom does not provide — the render throws and React
// unmounts the whole tree. The sequence logic under test lives in
// CentralCommand, not in the map; SosPanel (unmocked) still renders the
// SOS names the tests assert on.
vi.mock("../../src/components/command/CommandMap", () => ({
  default: () => null,
}));

/**
 * Fix 24 (CMD-1): the SOS and locations loaders now carry the ARC-W1
 * sequence guard the teams loader already had — only the latest-issued
 * fetch may commit, or a slow response resurrects a just-resolved SOS.
 * The fetch boundary is the global fetch (apiFetch rides it).
 *
 * Timing: real timers throughout. The second fetch round is driven by
 * the visibility-return handler (dispatching `visibilitychange` fires all
 * three fetchers immediately) instead of waiting out the 15 s poll —
 * `vi.useFakeTimers()` does not flush the session probe's promise chain
 * (the probe rides `AbortSignal.timeout`, which the fake-timer clock
 * never advances past), so the panel never unlocks under fake timers.
 */

function sos(id: string, name: string): TrappedSOS {
  return {
    id,
    deviceId: `dev-${id}`,
    lat: 36.75,
    lng: 3.06,
    name,
    status: "active",
    timestamp: new Date().toISOString(),
  };
}

function user(deviceId: string, name: string): UserLocationData {
  return { deviceId, lat: 36.75, lng: 3.06, name, role: "member", lastSeen: new Date().toISOString() };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Fire the visibility-return refresh (all three fetchers) once the first
// round is in flight.
async function fireSecondRound(fetchMock: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]: any[]) => String(u).includes("/api/sos/full"))).toBe(true));
  fireEvent(document, new Event("visibilitychange"));
}

describe("CentralCommand overlapping fetches (Fix 24 / CMD-1)", () => {
  let onRefresh: Mock<() => void>;

  beforeEach(() => {
    onRefresh = vi.fn(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a slow SOS fetch does not overwrite a newer one", async () => {
    let sosCalls = 0;
    let releaseFirst!: (v: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) {
        sosCalls += 1;
        if (sosCalls === 1) return firstGate;
        return jsonResponse(200, [sos("sos-b", "مناداة ب")]);
      }
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await fireSecondRound(fetchMock);
    // The second fetch returns the fresh list.
    await waitFor(() => expect(screen.getByText("مناداة ب")).toBeTruthy());
    // The slow first fetch finally lands with the stale list.
    releaseFirst(jsonResponse(200, [sos("sos-a", "مناداة أ")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("مناداة ب")).toBeTruthy();
    expect(screen.queryByText("مناداة أ")).toBeNull();
  });

  it("a slow SOS fetch does not resurrect a resolved SOS", async () => {
    let sosCalls = 0;
    let releaseFirst!: (v: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    // The second fetch is gated too, on purpose: it must land only AFTER
    // the resolve's local removal, so this test pins the resolve's seq
    // bump in handleResolveSos — without the bump, the second fetch is
    // the latest fetch and its commit would reinstall the resolved SOS.
    let releaseSecond!: (v: Response) => void;
    const secondGate = new Promise<Response>((resolve) => {
      releaseSecond = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) {
        sosCalls += 1;
        if (sosCalls === 1) return firstGate;
        return secondGate;
      }
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/sos-a/resolve") && init?.method === "POST") {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CentralCommand
        reports={[]}
        satellites={[]}
        sosCalls={[sos("sos-a", "مناداة أ")]}
        userLocation={null}
        lang="ar"
        onRefresh={onRefresh}
      />
    );
    await fireSecondRound(fetchMock);
    expect(screen.getByText("مناداة أ")).toBeTruthy();
    // Resolve locally: the panel button, then the dialog's confirm button
    // (both carry the label "تم الإنقاذ" once the dialog opens).
    fireEvent.click(screen.getByText("تم الإنقاذ"));
    expect(screen.getByText("تأكيد الإثبات")).toBeTruthy();
    fireEvent.click(screen.getAllByText("تم الإنقاذ")[1]);
    await waitFor(() => expect(screen.queryByText("مناداة أ")).toBeNull());
    // The second fetch — issued before the resolve — lands after it.
    // Without the resolve's seq bump this reinstalls the SOS; with it,
    // the commit is dropped.
    releaseSecond(jsonResponse(200, [sos("sos-a", "مناداة أ")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("مناداة أ")).toBeNull();
    // The slow first fetch lands with the pre-resolve list.
    releaseFirst(jsonResponse(200, [sos("sos-a", "مناداة أ")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("مناداة أ")).toBeNull();
  });

  it("a slow locations fetch does not overwrite a newer one or re-trigger the parent refresh", async () => {
    let locCalls = 0;
    let releaseFirst!: (v: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) return jsonResponse(200, []);
      if (String(url).includes("/api/locations")) {
        locCalls += 1;
        if (locCalls === 1) return firstGate;
        return jsonResponse(200, [user("u-new", "جديد")]);
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await fireSecondRound(fetchMock);
    await waitFor(() => expect(screen.getByText("جديد")).toBeTruthy());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    releaseFirst(jsonResponse(200, [user("u-old", "قديم")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("جديد")).toBeTruthy();
    expect(screen.queryByText("قديم")).toBeNull();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("a single fetch still commits (control)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) return jsonResponse(200, [sos("sos-a", "مناداة أ")]);
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await waitFor(() => expect(screen.getByText("مناداة أ")).toBeTruthy());
  });
});
