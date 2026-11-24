// Fix 35 (MAP-2/3/4): the heat toggle never re-ran the drawing effect, the
// layers control's breakpoint condition was backwards and never re-sampled
// on resize, and satellite popups kept the previous language. Renders a
// real Leaflet map — same flake class as safe-evacuation (init can exceed
// the 5 s timeout under CPU pressure): judge full-suite failures by an
// isolated re-run before treating them as real.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import InteractiveMap from "../../src/components/InteractiveMap";
import type { Report, SatelliteHotspot } from "../../src/types";

vi.mock("../../src/lib/basemap", () => ({ getCartoKey: async () => null, cartoUrl: () => "" }));

const report = (over: Record<string, unknown> = {}): Report => ({
  id: "R-1",
  lat: 36.8,
  lng: 7.5,
  locationName: "موقع اختبار",
  wilaya: "عنابة",
  description: "حريق",
  severity: "high",
  status: "pending",
  timestamp: new Date().toISOString(),
  consensusCount: 1,
  ...over,
});

const satellite = (over: Record<string, unknown> = {}): SatelliteHotspot => ({
  id: "S-1",
  lat: 36.82,
  lng: 7.52,
  confidence: 90,
  brightness: 400,
  scanTime: new Date().toISOString(),
  satellite: "VIIRS",
  wilaya: "عنابة",
  ...over,
});

const setWidth = (w: number) =>
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });

// Controllable matchMedia stub (jsdom has none): the component subscribes
// once on mount; firing the captured listeners simulates a breakpoint
// crossing.
let mqListeners: (() => void)[] = [];
const stubMatchMedia = () => {
  mqListeners = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn((_query: string) => ({
      matches: false,
      media: _query,
      addEventListener: (_type: string, cb: () => void) => {
        mqListeners.push(cb);
      },
      removeEventListener: (_type: string, cb: () => void) => {
        mqListeners = mqListeners.filter((l) => l !== cb);
      },
      dispatchEvent: () => false,
    }))
  );
};

const heatPaths = () => document.querySelectorAll(".leaflet-overlay-pane path").length;
const layersControl = () => document.querySelector(".leaflet-control-layers");

describe("InteractiveMap heat, layers control and satellite popups (Fix 35 — MAP-2/3/4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubMatchMedia();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWidth(1024);
  });

  it("MAP-2: the heat toggle adds then removes the heat circles", async () => {
    render(
      <InteractiveMap
        reports={[report()]}
        satellites={[]}
        onMapClick={() => {}}
        onConfirmReport={async () => true}
        selectedReportId={null}
        lang="ar"
      />
    );
    await waitFor(() => expect(document.querySelector(".leaflet-marker-icon")).toBeTruthy(), { timeout: 5000 });
    expect(heatPaths()).toBe(0);
    fireEvent.click(screen.getByText("🔥 حرارة"));
    await waitFor(() => expect(heatPaths()).toBe(1), { timeout: 5000 });
    fireEvent.click(screen.getByText("🔥 حرارة"));
    await waitFor(() => expect(heatPaths()).toBe(0), { timeout: 5000 });
  });

  it("MAP-3: narrow viewport collapses the layers control, wide expands it", async () => {
    setWidth(375);
    render(
      <InteractiveMap
        reports={[report()]}
        satellites={[]}
        onMapClick={() => {}}
        onConfirmReport={async () => true}
        selectedReportId={null}
        lang="ar"
      />
    );
    await waitFor(() => expect(layersControl()).toBeTruthy(), { timeout: 5000 });
    expect(layersControl()?.classList.contains("leaflet-control-layers-expanded")).toBe(false);
  });

  it("MAP-3: wide viewport expands the layers control, and crossing the breakpoint collapses it", async () => {
    setWidth(1024);
    render(
      <InteractiveMap
        reports={[report()]}
        satellites={[]}
        onMapClick={() => {}}
        onConfirmReport={async () => true}
        selectedReportId={null}
        lang="ar"
      />
    );
    await waitFor(() => expect(layersControl()).toBeTruthy(), { timeout: 5000 });
    expect(layersControl()?.classList.contains("leaflet-control-layers-expanded")).toBe(true);
    // Cross the breakpoint: the matchMedia listener must rebuild the
    // control with the narrow state — without it the control stays expanded.
    setWidth(375);
    mqListeners.forEach((l) => l());
    await waitFor(() => expect(layersControl()?.classList.contains("leaflet-control-layers-expanded")).toBe(false), {
      timeout: 5000,
    });
  });

  it("MAP-4: a satellite popup translates ar → fr with zero reports", async () => {
    const props = {
      satellites: [satellite()],
      onMapClick: () => {},
      onConfirmReport: async () => true,
      selectedReportId: null as string | null,
    };
    const { rerender } = render(<InteractiveMap reports={[]} {...props} lang="ar" />);
    await waitFor(() => expect(document.querySelector(".leaflet-marker-icon")).toBeTruthy(), { timeout: 5000 });
    fireEvent.click(document.querySelector(".leaflet-marker-icon") as Element);
    await waitFor(() => expect(document.querySelector(".leaflet-popup-content")).toBeTruthy(), { timeout: 5000 });
    expect(document.querySelector(".leaflet-popup-content")?.textContent).toContain("رصد حراري بالأقمار الصناعية");
    rerender(<InteractiveMap reports={[]} {...props} lang="fr" />);
    // New code rebuilds the markers on the language change, so the open
    // popup closes; old code leaves it open in Arabic. Either way, open it
    // again if needed and assert the French content.
    if (!document.querySelector(".leaflet-popup-content")) {
      await waitFor(() => expect(document.querySelector(".leaflet-marker-icon")).toBeTruthy(), { timeout: 5000 });
      fireEvent.click(document.querySelector(".leaflet-marker-icon") as Element);
      await waitFor(() => expect(document.querySelector(".leaflet-popup-content")).toBeTruthy(), { timeout: 5000 });
    }
    expect(document.querySelector(".leaflet-popup-content")?.textContent).toContain("Alerte Thermique Satellite");
    expect(document.querySelector(".leaflet-popup-content")?.textContent).not.toContain("رصد حراري بالأقمار الصناعية");
  });
}, 15000);
