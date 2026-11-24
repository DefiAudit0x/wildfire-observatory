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
  let osrmFails: boolean;

  beforeEach(() => {
    zonesData = [zoneA, zoneB];
    zonesFetchFails = false;
    osrmDeferred = null;
    osrmFails = false;
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
          if (osrmFails) {
            return new Response("{}", { status: 500 });
          }
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
    // Fix 26b: the 1 s default findBy timeout is too tight under parallel
    // load — the real Leaflet map init can push the route summary past it
    // (two intermittent failures at ~1.1 s / ~2.1 s in targeted runs, both
    // green on retry). The assertion is unchanged — the route must still
    // appear — it just tolerates a slow environment.
    await screen.findByText("المسار نشط على الخريطة", {}, { timeout: 5000 });
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

  it("a moved centre clears the active route with a moved notice (watch Major 4666538069)", async () => {
    await renderPage();
    await calculateRouteForB();
    // Admin moves B to new coordinates, keeping its id.
    zonesData = [zoneA, { ...zoneB, lat: 36.9, lng: 7.9 }];
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    expect(screen.queryByText("المسار نشط على الخريطة")).toBeNull();
    expect(screen.queryByText("مسار طريق حقيقي")).toBeNull();
    expect(screen.getByText("تم نقل مركز الإخلاء هذا — أُلغي المسار إليه.")).toBeTruthy();
    // B is still listed (same id) — only the route to its OLD destination
    // is gone.
    expect(screen.getByText("مركز ب")).toBeTruthy();
  });

  it("a centre moved mid-calculation does not resurrect the old destination (watch Major 4666538069)", async () => {
    osrmDeferred = { resolve: () => {} };
    await renderPage();
    const buttons = screen.getAllByText("اعرض مسار الطريق");
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    expect(screen.getAllByText("جاري حساب المسار...")).toHaveLength(2);
    // B moves while OSRM is still pending.
    zonesData = [zoneA, { ...zoneB, lat: 36.9, lng: 7.9 }];
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    await act(async () => {
      osrmDeferred!.resolve(osrmSuccessResponse());
    });
    expect(screen.queryByText("المسار نشط على الخريطة")).toBeNull();
    expect(screen.queryByText("مسار طريق حقيقي")).toBeNull();
    expect(
      screen.getByText("تم نقل مركز الإخلاء هذا أثناء حساب المسار — اختر مركزًا آخر.")
    ).toBeTruthy();
  });

  it("clearing the route mid-speech stops the voice summary (watch Major 4666538087)", async () => {
    const cancelMock = vi.fn();
    const speakMock = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak: speakMock, cancel: cancelMock });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        lang = "";
        rate = 1;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(text: string) {
          this.text = text;
        }
      }
    );
    await renderPage();
    await calculateRouteForB();
    // Start the voice summary.
    await act(async () => {
      fireEvent.click(screen.getByText("استمع إلى ملخص المسار"));
    });
    expect(speakMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("إيقاف الملاحة الصوتية")).toBeTruthy();
    // Admin deactivates B mid-speech — the stop button unmounts with the
    // route, so the clearing branch itself must cancel.
    zonesData = [zoneA];
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("إيقاف الملاحة الصوتية")).toBeNull();
    expect(screen.queryByText("المسار نشط على الخريطة")).toBeNull();
  });

  it("with no change, a centre stays selectable and its route calculates (control)", async () => {
    await renderPage();
    await calculateRouteForB();
    expect(screen.getByText("مسار طريق حقيقي")).toBeTruthy();
  });

  async function calculateEstimateRouteForB() {
    const buttons = screen.getAllByText("اعرض مسار الطريق");
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    // The estimate disclosure marks the estimate path as settled.
    await screen.findByText(/تعذر الوصول لخدمة الطرق/, {}, { timeout: 5000 });
  }

  it("EVAC-3: on OSRM failure the summary heading says estimate, not real road", async () => {
    osrmFails = true;
    await renderPage();
    await calculateEstimateRouteForB();
    expect(screen.getByText("مسار تقديري (خط مستقيم)")).toBeTruthy();
    expect(screen.queryByText("مسار طريق حقيقي")).toBeNull();
  });

  it("EVAC-3: on OSRM failure the zone button says estimate calculated, not active on the map", async () => {
    osrmFails = true;
    await renderPage();
    await calculateEstimateRouteForB();
    expect(screen.getByText("التقدير محسوب")).toBeTruthy();
    expect(screen.queryByText("المسار نشط على الخريطة")).toBeNull();
  });

  it("EVAC-3: on OSRM failure the voice summary opens with the estimate sentence", async () => {
    const speakMock = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak: speakMock, cancel: vi.fn() });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        lang = "";
        rate = 1;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(text: string) {
          this.text = text;
        }
      }
    );
    osrmFails = true;
    await renderPage();
    await calculateEstimateRouteForB();
    await act(async () => {
      fireEvent.click(screen.getByText("استمع إلى ملخص المسار"));
    });
    expect(speakMock).toHaveBeenCalledTimes(1);
    const spoken = String(speakMock.mock.calls[0][0].text);
    expect(spoken.startsWith("تم حساب تقدير خط مستقيم")).toBe(true);
    expect(spoken).not.toContain("مسار طريق حقيقي");
  });
  // Fix 26b: the whole suite runs on 1.5 shared CPUs, and the real Leaflet
  // map init can push a test past Vitest's 5 s default test timeout under
  // full-suite load (the speech test hit it at exactly 5000 ms) — the
  // findBy timeouts are not the binding constraint, the test timeout is.
}, 15000);
