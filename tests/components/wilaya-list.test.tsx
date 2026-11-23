import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import WilayaList from "../../src/components/WilayaList";
import StatisticsPanel from "../../src/components/StatisticsPanel";
import type { WilayaStatus } from "../../src/types";

function mkWilaya(over: Partial<WilayaStatus> = {}): WilayaStatus {
  return {
    nameAr: "عنابة",
    nameFr: "Annaba",
    activeFires: 2,
    satelliteHotspots: 1,
    severity: "critical",
    evacuationRecommended: true,
    emergencyPhone: "1021",
    ...over,
  };
}

function stubHistory() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({ days: 0, generatedAt: new Date().toISOString(), buckets: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("WilayaList evacuation wording (Fix 25 — WIL-1)", () => {
  it("a recommended wilaya says critical reports advise evacuation — never active instructions (ar)", () => {
    render(<WilayaList wilayas={[mkWilaya({ evacuationRecommended: true })]} lang="ar" />);
    expect(screen.getByText("بلاغات حرجة حديثة — يُنصح بالإخلاء")).toBeTruthy();
    expect(screen.queryByText("توجيهات إخلاء نشطة")).toBeNull();
  });

  it("a non-recommended wilaya says no recent critical reports — never 'no orders' (ar)", () => {
    render(<WilayaList wilayas={[mkWilaya({ evacuationRecommended: false, severity: "low" })]} lang="ar" />);
    expect(screen.getByText("لا بلاغات حرجة حديثة")).toBeTruthy();
    expect(screen.queryByText("لا توجد أوامر إخلاء")).toBeNull();
  });

  it("renders the report-attributed wording in French too (recommended)", () => {
    render(<WilayaList wilayas={[mkWilaya({ evacuationRecommended: true })]} lang="fr" />);
    expect(screen.getByText("Évacuation conseillée (signalements récents)")).toBeTruthy();
  });

  it("renders the report-attributed wording in French too (not recommended)", () => {
    render(<WilayaList wilayas={[mkWilaya({ evacuationRecommended: false, severity: "low" })]} lang="fr" />);
    expect(screen.getByText("Aucun signalement critique récent")).toBeTruthy();
  });
});

describe("StatisticsPanel threatened-wilayas wording (Fix 25 — WIL-1)", () => {
  it("a flagged wilaya describes recent critical reports, not evacuations in progress (ar)", () => {
    stubHistory();
    render(
      <StatisticsPanel reports={[]} satellites={[]} wilayas={[mkWilaya({ evacuationRecommended: true })]} lang="ar" />
    );
    expect(screen.getByText("بلاغات حرجة حديثة في هذه المناطق")).toBeTruthy();
    expect(screen.queryByText("إجراءات إخلاء نشطة في هذه المناطق")).toBeNull();
  });

  it("a threatened wilaya without the flag describes non-critical reports, not teams on alert (ar)", () => {
    stubHistory();
    render(
      <StatisticsPanel
        reports={[]}
        satellites={[]}
        wilayas={[mkWilaya({ evacuationRecommended: false, severity: "high" })]}
        lang="ar"
      />
    );
    expect(screen.getByText("بلاغات حديثة دون مستوى حرج — تابع المستجدات")).toBeTruthy();
    expect(screen.queryByText("مراقبة مكثفة وفرق تدخل جاهزة")).toBeNull();
  });

  it("no threatened wilaya says no recent reports — never 'all regions under control' (ar)", () => {
    stubHistory();
    render(<StatisticsPanel reports={[]} satellites={[]} wilayas={[]} lang="ar" />);
    expect(screen.getByText("لا بلاغات حديثة في هذه المناطق")).toBeTruthy();
    expect(screen.queryByText("جميع المناطق تحت السيطرة")).toBeNull();
  });
});
