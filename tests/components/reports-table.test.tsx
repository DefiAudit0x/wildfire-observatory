// Fix 34 (RPT-1): the four status filter buttons always rendered their Arabic
// label, even in French — although labelFr already existed and the row chips
// already localized. No fetch stub is needed: useReportModeration fetches
// only on moderation clicks, never on mount.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ReportsTable from "../../src/components/command/ReportsTable";
import type { Report } from "../../src/types";

const report = (id: string, status: Report["status"], name: string): Report => ({
  id,
  lat: 36.7,
  lng: 5.0,
  locationName: name,
  wilaya: "عنابة",
  description: "حريق",
  severity: "high",
  status,
  timestamp: new Date().toISOString(),
  consensusCount: 1,
});

const four = [
  report("R-1", "pending", "موقع قيد المراجعة"),
  report("R-2", "verified", "موقع موثق"),
  report("R-3", "rejected", "موقع مرفوض"),
  report("R-4", "resolved", "موقع محلول"),
];

describe("ReportsTable status filters (Fix 34 — RPT-1)", () => {
  it("renders the four status filters in French with their counts", () => {
    render(<ReportsTable isArabic={false} reports={four} onChanged={() => {}} notify={() => {}} />);
    expect(screen.getByRole("button", { name: /En attente/ }).textContent).toContain("(1)");
    expect(screen.getByRole("button", { name: /Vérifié/ }).textContent).toContain("(1)");
    expect(screen.getByRole("button", { name: /Rejeté/ }).textContent).toContain("(1)");
    expect(screen.getByRole("button", { name: /Résolu/ }).textContent).toContain("(1)");
    expect(screen.getByRole("button", { name: /Tous/ }).textContent).toContain("(4)");
  });

  it('clicking "Vérifié" leaves only the verified row visible', () => {
    render(<ReportsTable isArabic={false} reports={four} onChanged={() => {}} notify={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Vérifié/ }));
    expect(screen.getByText("موقع موثق")).toBeTruthy();
    expect(screen.queryByText("موقع قيد المراجعة")).toBeNull();
    expect(screen.queryByText("موقع مرفوض")).toBeNull();
    expect(screen.queryByText("موقع محلول")).toBeNull();
  });

  it("renders the Arabic filter labels (control)", () => {
    render(<ReportsTable isArabic={true} reports={four} onChanged={() => {}} notify={() => {}} />);
    expect(screen.getByRole("button", { name: /قيد المراجعة/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /موثق رسمي/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /مرفوض/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /تم الحل/ })).toBeTruthy();
  });
});
