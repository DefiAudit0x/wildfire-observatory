import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

describe("StatisticsPanel history legend and load states (Fix 36 — STA-2/STA-3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  const twoDays = {
    days: 2,
    generatedAt: new Date().toISOString(),
    buckets: [
      { date: "2026-11-20", reports: 2, verified: 1, sos: 1, hotspots: 0 },
      { date: "2026-11-21", reports: 1, verified: 0, sos: 0, hotspots: 0 },
    ],
  };

  it.each(["ar", "fr"] as const)("legend says today is at the right, and the first bar is still the oldest bucket (%s)", async (lang) => {
    stubHistory(twoDays);
    render(<StatisticsPanel reports={[]} satellites={[]} wilayas={[]} lang={lang} />);
    await waitFor(() => expect(barTitles()).toHaveLength(2));
    expect(screen.getByText(lang === "ar" ? "اليوم في أقصى اليمين" : "Aujourd'hui à droite")).toBeTruthy();
    expect(screen.queryByText(lang === "ar" ? "اليوم في أقصى اليسار" : "Aujourd'hui à gauche")).toBeNull();
    // Legend-only fix: the bar order is untouched (oldest first).
    expect(barTitles()[0]).toContain("2026-11-20");
    expect(barTitles()[1]).toContain("2026-11-21");
  });

  it("a failed history load shows an error with retry, and retry recovers", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response("{}", { status: 500 });
        return new Response(JSON.stringify(twoDays), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    render(<StatisticsPanel reports={[]} satellites={[]} wilayas={[]} lang="ar" />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(barTitles()).toHaveLength(0);
    expect(screen.getByText(/تعذّر تحميل سجل الأيام الثلاثين/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("إعادة المحاولة")).toBeTruthy());
    fireEvent.click(screen.getByText("إعادة المحاولة"));
    await waitFor(() => expect(barTitles()).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a loading line while the history is in flight, then the bars", async () => {
    let resolveHistory!: (res: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/api/history")) {
          return new Promise<Response>((resolve) => {
            resolveHistory = resolve;
          });
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      })
    );
    render(<StatisticsPanel reports={[]} satellites={[]} wilayas={[]} lang="ar" />);
    expect(screen.getByText("جاري تحميل السجل…")).toBeTruthy();
    expect(barTitles()).toHaveLength(0);
    await act(async () => {
      resolveHistory(new Response(JSON.stringify(twoDays), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    await waitFor(() => expect(barTitles()).toHaveLength(2));
    expect(screen.queryByText("جاري تحميل السجل…")).toBeNull();
  });
});
