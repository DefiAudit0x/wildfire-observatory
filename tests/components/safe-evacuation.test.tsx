import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import SafeEvacuation from "../../src/components/SafeEvacuation";
import { useLiveEvents } from "../../src/utils/live";

vi.mock("../../src/utils/live", () => ({ useLiveEvents: vi.fn() }));

interface Zone {
  id: string;
  nameAr: string;
  nameFr: string;
  capacity: number;
  lat: number;
  lng: number;
  hasMedical: boolean;
  isActive?: boolean;
}

const zoneA: Zone = {
  id: "zone-a",
  nameAr: "مركز أ",
  nameFr: "Centre A",
  capacity: 1000,
  lat: 36.81,
  lng: 7.61,
  hasMedical: true,
  isActive: true,
};

const zoneB: Zone = {
  id: "zone-b",
  nameAr: "مركز ب",
  nameFr: "Centre B",
  capacity: 500,
  lat: 36.82,
  lng: 7.62,
  hasMedical: false,
  isActive: true,
};

function osrmSuccessResponse() {
  return new Response(
    JSON.stringify({
      routes: [{ distance: 5000, duration: 600, geometry: { coordinates: [[7.6, 36.8], [7.61, 36.81]] } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function capturedLiveHandler() {
  // The mock accumulates calls across tests in the file — the current
  // render's handler is the LAST call, not the first (an earlier test's
  // handler belongs to an unmounted component).
  const calls = (useLiveEvents as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  // Fix 26 review (Nit N2): on old code the component never subscribes,
  // so the calls list is empty — fail with a self-describing error instead
  // of a bare TypeError from indexing an empty array.
  if (calls.length === 0) {
    throw new Error("useLiveEvents was never called — the component does not subscribe to live events");
  }
  return calls[calls.length - 1][0] as (event: { ts: number; type: string }) => void;
}

describe("SafeEvacuation zone refresh (Fix 26 — EVAC-2)", () => {
  let zonesData: Zone[];
  let zonesFetchFails: boolean;
  let osrmDeferred: { resolve: (res: Response) => void } | null;

  beforeEach(() => {
    zonesData = [zoneA, zoneB];
    zonesFetchFails = false;
    osrmDeferred = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/safezones") {
          if (zonesFetchFails) {
            return new Response("{}", { status: 500 });
          }
          return new Response(JSON.stringify(zonesData), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "/api/config") {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.startsWith("https://router.project-osrm.org")) {
          if (osrmDeferred) {
            return new Promise<Response>((resolve) => {
              osrmDeferred = { resolve };
            });
          }
          return osrmSuccessResponse();
        }
        return new Response("{}", { status: 404 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function renderPage() {
    render(<SafeEvacuation lang="ar" userLocation={{ lat: 36.8, lng: 7.6 }} reports={[]} satellites={[]} />);
    await screen.findByText("مركز ب");
  }

  async function calculateRouteForB() {
    const buttons = screen.getAllByText("اعرض مسار الطريق");
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await screen.findByText("المسار نشط على الخريطة");
  }

  it("a deactivated centre disappears, its active route is cleared, and the notice shows", async () => {
    await renderPage();
    await calculateRouteForB();
    // Admin deactivates B; the server broadcasts safezones:changed.
    zonesData = [zoneA];
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    expect(screen.queryByText("مركز ب")).toBeNull();
    expect(screen.queryByText("مسار طريق حقيقي")).toBeNull();
    expect(
      screen.getByText("تم إلغاء تنشيط مركز الإخلاء هذا أو إزالته — أُلغي المسار إليه.")
    ).toBeTruthy();
  });

  it("a refresh landing mid-calculation does not resurrect the dead centre", async () => {
    osrmDeferred = { resolve: () => {} };
    await renderPage();
    const buttons = screen.getAllByText("اعرض مسار الطريق");
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    expect(screen.getAllByText("جاري حساب المسار...")).toHaveLength(2);
    // The refresh lands while OSRM is still pending; the route was nulled
    // at the start of the calculation, so only the post-fetch guard can
    // stop the resurrection.
    zonesData = [zoneA];
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    await act(async () => {
      osrmDeferred!.resolve(osrmSuccessResponse());
    });
    expect(screen.queryByText("المسار نشط على الخريطة")).toBeNull();
    expect(screen.queryByText("مسار طريق حقيقي")).toBeNull();
    expect(
      screen.getByText("تم إلغاء تنشيط مركز الإخلاء هذا أو إزالته أثناء حساب المسار — اختر مركزًا آخر.")
    ).toBeTruthy();
  });

  it("the 60-second backstop refetches the zones even with no live event", async () => {
    vi.useFakeTimers();
    const fetchMock = fetch as unknown as { mock: { calls: unknown[][] } };
    render(<SafeEvacuation lang="ar" userLocation={{ lat: 36.8, lng: 7.6 }} reports={[]} satellites={[]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const zonesCalls = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/safezones").length;
    expect(zonesCalls()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(zonesCalls()).toBe(2);
  });

  it("a failed zone refresh keeps the existing list and the active route (review Major M1)", async () => {
    await renderPage();
    await calculateRouteForB();
    // The next refresh fails (500) — the old list must survive, the route
    // must stay, and no false deactivation notice may appear. The honest
    // "couldn't verify" banner still shows.
    zonesFetchFails = true;
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    expect(screen.getByText("المسار نشط على الخريطة")).toBeTruthy();
    expect(screen.getByText("مسار طريق حقيقي")).toBeTruthy();
    expect(screen.queryByText("تم إلغاء تنشيط مركز الإخلاء هذا أو إزالته — أُلغي المسار إليه.")).toBeNull();
    expect(
      screen.getByText("تعذر التحقق من حالة مراكز الإخلاء حاليًا. لا تعتبر أي مركز آمنًا أو مفتوحًا دون تأكيد رسمي.")
    ).toBeTruthy();
  });

  it("with no change, a centre stays selectable and its route calculates (control)", async () => {
    await renderPage();
    await calculateRouteForB();
    expect(screen.getByText("مسار طريق حقيقي")).toBeTruthy();
  });
});
