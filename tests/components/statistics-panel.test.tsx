// Fix 35 (STA-1): the verified-share stat was titled as an instant-AI
// validation rate, but "verified" is granted only by a trusted badge or
// operator moderation — AI only writes the advisory aiVerification object.
// The fix relabels the card; the value stays the verified share.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import StatisticsPanel from "../../src/components/StatisticsPanel";
import type { Report } from "../../src/types";

const report = (id: string, status: Report["status"]): Report => ({
  id,
  lat: 36.7,
  lng: 5.0,
  locationName: `موقع ${id}`,
  wilaya: "عنابة",
  description: "حريق",
  severity: "high",
  status,
  timestamp: new Date().toISOString(),
  consensusCount: 1,
});

describe("StatisticsPanel verification label (Fix 35 — STA-1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ buckets: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Arabic title names report verification, not AI, and the value is the verified share", () => {
    render(
      <StatisticsPanel reports={[report("R-1", "verified"), report("R-2", "pending")]} satellites={[]} wilayas={[]} lang="ar" />
    );
    expect(screen.getByText("معدل توثيق البلاغات")).toBeTruthy();
    expect(screen.queryByText(/الذكاء الاصطناعي/)).toBeNull();
    expect(screen.getByText("50%")).toBeTruthy();
  });

  it("French title names report verification, not AI, and the value is the verified share", () => {
    render(
      <StatisticsPanel reports={[report("R-1", "verified"), report("R-2", "pending")]} satellites={[]} wilayas={[]} lang="fr" />
    );
    expect(screen.getByText("Taux de vérification des signalements")).toBeTruthy();
    expect(screen.queryByText(/par l'IA/)).toBeNull();
    expect(screen.getByText("50%")).toBeTruthy();
  });
});
