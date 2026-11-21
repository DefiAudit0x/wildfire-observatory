import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import StatisticsPanel from "../../src/components/StatisticsPanel";

function stubHistory(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }))
  );
}

function barTitles(): string[] {
  return [...document.querySelectorAll("div[title]")]
    .map((el) => el.getAttribute("title") || "")
    .filter((t) => t.includes("بلاغات"));
}

describe("StatisticsPanel history chart (Fix 12c)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("marks satellite data unavailable instead of plotting confirmed zeros", async () => {
    stubHistory({
      days: 2,
      generatedAt: new Date().toISOString(),
      hotspotsUnavailable: true,
      buckets: [
        { date: "2026-11-20", reports: 2, verified: 1, sos: 1, hotspots: 0 },
        { date: "2026-11-21", reports: 1, verified: 0, sos: 0, hotspots: 0 },
      ],
    });
    render(<StatisticsPanel reports={[]} satellites={[]} wilayas={[]} lang="ar" />);
    await waitFor(() => expect(barTitles().length).toBe(2));
    expect(await screen.findByText(/بيانات الأقمار غير متاحة حالياً/i)).toBeInTheDocument();
    const titles = barTitles();
    expect(titles.some((t) => t.includes("غير متاحة"))).toBe(true);
    expect(titles.some((t) => t.includes("أقمار: 0"))).toBe(false);
  });

  it("still shows hotspot counts when the satellite feed is healthy", async () => {
    stubHistory({
      days: 1,
      generatedAt: new Date().toISOString(),
      buckets: [{ date: "2026-11-21", reports: 1, verified: 0, sos: 0, hotspots: 3 }],
    });
    render(<StatisticsPanel reports={[]} satellites={[]} wilayas={[]} lang="ar" />);
    await waitFor(() => expect(barTitles().length).toBe(1));
    expect(barTitles()[0]).toContain("أقمار: 3");
    expect(screen.queryByText(/بيانات الأقمار غير متاحة حالياً/i)).toBeNull();
    expect(screen.queryByText(/بيانات الأقمار جزئية حالياً/)).toBeNull();
  });
  it.each(["ar", "fr"] as const)("labels partial counts and keeps their bar contribution (%s)", async (lang) => {
    stubHistory({ hotspotsPartial: true, buckets: [
      { date: "2026-11-20", reports: 2, verified: 0, sos: 0, hotspots: 0 },
      { date: "2026-11-21", reports: 0, verified: 0, sos: 0, hotspots: 4 },
    ] });
    render(<StatisticsPanel reports={[]} satellites={[]} wilayas={[]} lang={lang} />);
    await waitFor(() => expect(barTitles()).toHaveLength(2));
    expect(barTitles()[1]).toContain(lang === "ar" ? "أقمار: 4 (جزئي)" : "أقمار: 4 (partiel)");
    expect(screen.getByText(lang === "ar" ? /بيانات الأقمار جزئية حالياً/ : /Données satellites actuellement partielles/)).toBeInTheDocument();
    expect((document.querySelectorAll("div[title]")[1] as HTMLElement).style.height).toBe("100%");
    expect((document.querySelectorAll("div[title]")[0] as HTMLElement).style.height).toBe("50%");
  });
});
