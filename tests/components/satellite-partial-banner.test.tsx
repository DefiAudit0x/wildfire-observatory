import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import MainContent from "../../src/components/layout/MainContent";

// The shared content warning remains visible across all satellite consumers:
// home, radar, command, evacuation and the map/statistics tab.
describe("Fix 12e satellite partial warning", () => {
  it.each(["ar", "fr"] as const)("marks the content area partial and removes the warning on recovery (%s)", (lang) => {
    const props = {
      isArabic: lang === "ar", lang, activeTab: "guides" as const,
      reports: [], satellites: [], wilayas: [], sosCalls: [], userLocation: null,
      mapClickedCoords: null, selectedReportId: null, privilegedTabVisible: false,
      rosterVisible: false, syncState: "partial" as const,
      reportsHealth: { lastSuccess: null, lastAttemptOk: false },
      onMapClick: vi.fn(), onConfirmReport: async () => true,
      onCreateReport: async () => undefined, onSelectReport: vi.fn(),
      onNavigate: vi.fn(), onTriggerSOS: vi.fn(), onRefresh: vi.fn(), onClearMapPin: vi.fn(),
    };
    const { rerender } = render(<MainContent {...props} satellitesPartial />);
    expect(screen.getByRole("status")).toHaveTextContent(lang === "ar" ? "بيانات الأقمار جزئية حالياً" : "Données satellites partielles");
    rerender(<MainContent {...props} satellitesPartial={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
