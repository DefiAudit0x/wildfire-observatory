import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import CommandMap from "../../src/components/command/CommandMap.js";
import type { Report } from "../../src/types.js";
import type { UserLocationData } from "../../src/components/command/StatCards.js";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const userA: UserLocationData = {
  deviceId: "DEV-1",
  lat: 36.7,
  lng: 5.0,
  name: "متطوع 1",
  role: "volunteer",
  lastSeen: new Date().toISOString(),
};

function report(id: string, locationName: string): Report {
  return {
    id,
    lat: 36.75,
    lng: 3.05,
    locationName,
    wilaya: "عنابة",
    description: "بلاغ اختبار",
    severity: "high",
    status: "pending",
    timestamp: new Date().toISOString(),
    consensusCount: 1,
  };
}

function renderMap(props: { activeUsers?: UserLocationData[]; reports?: Report[] }) {
  return render(
    <CommandMap
      isArabic
      satellites={[]}
      activeUsers={props.activeUsers ?? []}
      reports={props.reports ?? []}
      sosCalls={[]}
      teamMembers={[]}
      focus={null}
    />
  );
}

function markers(): Element[] {
  return Array.from(document.querySelectorAll(".leaflet-marker-icon"));
}

function popupText(): string | null {
  const content = document.querySelector(".leaflet-popup-content");
  return content ? content.textContent : null;
}

describe("CommandMap popup keys (Fix 33 — CMAP-1)", () => {
  it("a moved user keeps its popup: same deviceId at new coordinates re-opens it", async () => {
    const { rerender } = renderMap({ activeUsers: [userA] });
    await waitFor(() => expect(markers().length).toBe(1));
    fireEvent.click(markers()[0]);
    await waitFor(() => expect(popupText()).toContain("متطوع 1"));
    rerender(
      <CommandMap
        isArabic
        satellites={[]}
        activeUsers={[{ ...userA, lat: 36.71, lng: 5.01 }]}
        reports={[]}
        sosCalls={[]}
        teamMembers={[]}
        focus={null}
      />
    );
    await waitFor(() => expect(popupText()).toContain("متطوع 1"));
  });

  it("two co-located reports keep their own popups: the first report's popup survives a rebuild", async () => {
    const { rerender } = renderMap({ reports: [report("R-1", "موقع أ"), report("R-2", "موقع ب")] });
    await waitFor(() => expect(markers().length).toBe(2));
    fireEvent.click(markers()[0]);
    await waitFor(() => expect(popupText()).toContain("موقع أ"));
    rerender(
      <CommandMap
        isArabic
        satellites={[]}
        activeUsers={[]}
        reports={[report("R-1", "موقع أ"), report("R-2", "موقع ب")]}
        sosCalls={[]}
        teamMembers={[]}
        focus={null}
      />
    );
    await waitFor(() => expect(popupText()).toContain("موقع أ"));
    expect(popupText()).not.toContain("موقع ب");
  });
});
