import { cloneElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import L from "leaflet";
import AdminPanel from "../../src/components/AdminPanel";
import InteractiveMap from "../../src/components/InteractiveMap";
import MainContent from "../../src/components/layout/MainContent";
import type { Language, Report } from "../../src/types";

vi.mock("../../src/lib/basemap", () => ({ getCartoKey: async () => null, cartoUrl: () => "" }));

const report: Report = {
  id: "r1", lat: 36.8, lng: 7.5, locationName: "Forest", wilaya: "Annaba",
  description: 'Fire, "near road"', status: "pending", severity: "high",
  timestamp: "2026-11-20T10:00:00Z", consensusCount: 1,
};

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ADM-1 operator CSV download", () => {
  it.each(["=1+1+10000", "+SUM(1)", "-SUM(1)", "@SUM(1)", "\tformula", "\rformula", "  =1+1", "  \tformula", "  \rformula"])(
    "neutralizes %j in exported fields and preserves ordinary rows", async (value) => {
      // Fix 8e: the export's reporter name comes from the private identity
      // shard, not the report prop (ADM-2 stripped it from public data) —
      // so the identity fetch must return the malicious value too. Before
      // this, the stub returned {} for every URL and the fetch raced the
      // export click: if it resolved first, the merge wiped reporterName to
      // "" and the test failed intermittently.
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/identity")) {
          // Only the malicious report's identity carries the value; the
          // ordinary row's identity is empty, as the test expects.
          const id = decodeURIComponent(url.split("/api/reports/")[1]?.split("/identity")[0] ?? "");
          if (id === value) {
            return new Response(JSON.stringify({ reporterName: value, reporterPhone: "+213555010203" }), { status: 200 });
          }
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }));
      const createObjectURL = vi.fn((_blob: Blob) => "blob:csv");
      vi.stubGlobal("URL", class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = vi.fn();
      });
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      const malicious = { ...report, id: value, locationName: value, wilaya: value, description: value, reporterName: value, timestamp: value };
      render(<AdminPanel reports={[malicious, report]} onRefresh={() => {}} lang="fr" />);
      fireEvent.click(await screen.findByRole("button", { name: "Exporter CSV" }));
      const csv = await readBlob(createObjectURL.mock.calls[0][0] as Blob);
      const safe = "'" + value;
      const quoted = `"${safe.replace(/"/g, '""')}"`;
      const unquoted = /[",\n\r]/.test(safe) ? quoted : safe;
      expect(csv).toContain(`${unquoted},${quoted},${quoted},pending,high,${quoted},${quoted},${unquoted}`);
      expect(csv).toContain('ID,الموقع,الولاية,الحالة,الخطورة,الوصف,المُبلغ,الوقت');
      expect(csv).toContain('r1,"Forest","Annaba",pending,high,"Fire, ""near road""","",2026-11-20T10:00:00Z');
      expect(malicious.description).toBe(value);
    }
  );
});

const authorityCases = (["ar", "fr"] as const).flatMap((lang) =>
  (["official", "volunteer"] as const).flatMap((reporterType) =>
    (["pending", "rejected", "resolved"] as const).map((status) => ({ lang, reporterType, status }))
  )
);

function labels(lang: Language, type: Report["reporterType"]) {
  return {
    popup: type === "official" ? (lang === "ar" ? "الحماية المدنية" : "Protection Civile") : (lang === "ar" ? "متطوع معتمد" : "Bénévole Météo"),
    feed: type === "official" ? (lang === "ar" ? "جهة رسمية" : "Officiel") : (lang === "ar" ? "متطوع" : "Bénévole"),
    citizen: lang === "ar" ? "مواطن" : "Citoyen",
  };
}

describe("MAP-1 reporter authority", () => {
  it.each(authorityCases)("popup: $lang $reporterType $status", async ({ lang, reporterType, status }) => {
    const marker = vi.spyOn(L, "marker");
    const element = <InteractiveMap reports={[{ ...report, reporterType, status }]} satellites={[]} onMapClick={() => {}} onConfirmReport={async () => true} selectedReportId={null} lang={lang} />;
    const { rerender } = render(element);
    await waitFor(() => expect(marker).toHaveBeenCalled());
    const content: unknown = marker.mock.results.at(-1)?.value.getPopup()?.getContent();
    const popup = content instanceof HTMLElement ? content.innerHTML : String(content);
    const text = labels(lang, reporterType);
    expect(popup).not.toContain(text.popup);
    expect(popup).toContain(text.citizen);
    rerender(cloneElement(element, { reports: [{ ...report, reporterType, status: "verified" }] }));
    const verifiedContent: unknown = marker.mock.results.at(-1)?.value.getPopup()?.getContent();
    expect(verifiedContent instanceof HTMLElement ? verifiedContent.innerHTML : String(verifiedContent)).toContain(text.popup);
  });

  it.each(authorityCases)("feed: $lang $reporterType $status", async ({ lang, reporterType, status }) => {
    const element = <MainContent isArabic={lang === "ar"} lang={lang} activeTab="map"
      reports={[{ ...report, reporterType, status }]} satellites={[]} wilayas={[]} sosCalls={[]}
      userLocation={null} mapClickedCoords={null} selectedReportId={null} privilegedTabVisible={false} rosterVisible={false}
      syncState="never" reportsHealth={{ lastSuccess: null, lastAttemptOk: false }}
      onMapClick={() => {}} onConfirmReport={async () => true} onCreateReport={async () => {}}
      onSelectReport={() => {}} onNavigate={() => {}} onTriggerSOS={() => {}} onRefresh={() => {}} onClearMapPin={() => {}} />;
    const { rerender } = render(element);
    const card = screen.getByRole("button", { name: /Forest/ });
    const label = within(card).queryByText(new RegExp(labels(lang, reporterType).feed));
    expect(label).not.toBeInTheDocument();
    rerender(cloneElement(element, { reports: [{ ...report, reporterType, status: "verified" }] }));
    expect(within(screen.getByRole("button", { name: /Forest/ })).getByText(new RegExp(labels(lang, reporterType).feed))).toBeInTheDocument();
    // Let the lazy map finish before cleanup, avoiding suspended updates leaking between cases.
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});
