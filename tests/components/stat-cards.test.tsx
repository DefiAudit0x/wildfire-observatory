// Fix 34 (CSTAT-1): the Admins card counted activeUsers with role
// "admin"/"superadmin", but no code path ever writes those roles into the
// /api/locations map — the card permanently showed 0 labelled as live admin
// presence. The fix removes the card (and the grid goes 8 → 7 columns).
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import StatCards, { type UserLocationData } from "../../src/components/command/StatCards";
import type { Report, TrappedSOS } from "../../src/types";

const user = (deviceId: string, role: string): UserLocationData => ({
  deviceId,
  lat: 36.7,
  lng: 5.0,
  name: `مستخدم ${deviceId}`,
  role,
  lastSeen: new Date().toISOString(),
});

const report = (id: string, status: Report["status"]): Report => ({
  id,
  lat: 36.7,
  lng: 5.0,
  locationName: `موقع ${id}`,
  wilaya: "عنابة",
  description: "حريق",
  severity: status === "verified" ? "critical" : "high",
  status,
  timestamp: new Date().toISOString(),
  consensusCount: 1,
});

const sosCall = (): TrappedSOS => ({
  id: "SOS-1",
  deviceId: "DEV-9",
  lat: 36.7,
  lng: 5.0,
  name: "متطوع 1",
  status: "active",
  timestamp: new Date().toISOString(),
});

describe("StatCards admin card (Fix 34 — CSTAT-1)", () => {
  it("has no Admins card in either language, even with an admin-role user fed in", () => {
    const users = [user("U-1", "citizen"), user("U-2", "volunteer"), user("U-3", "official"), user("U-4", "admin")];
    const { rerender } = render(
      <StatCards isArabic={true} reports={[]} satellites={[]} sosCalls={[]} activeUsers={users} registeredTeams={[]} />
    );
    expect(screen.queryByText("المشرفون")).toBeNull();
    // The removed card's sub-line "متصل الآن" also appeared on the online
    // card — with the card gone it must occur exactly once (the online card).
    // On old code it occurs twice (Admins card + online card).
    expect(screen.getAllByText("متصل الآن").length).toBe(1);
    rerender(
      <StatCards isArabic={false} reports={[]} satellites={[]} sosCalls={[]} activeUsers={users} registeredTeams={[]} />
    );
    expect(screen.queryByText("Admins")).toBeNull();
  });

  it("the other seven cards still render with correct counts (control)", () => {
    const users = [user("U-1", "citizen"), user("U-2", "volunteer"), user("U-3", "official")];
    render(
      <StatCards
        isArabic={true}
        reports={[report("R-1", "pending"), report("R-2", "verified")]}
        satellites={[]}
        sosCalls={[sosCall()]}
        activeUsers={users}
        registeredTeams={[]}
      />
    );
    const expectedCards = [
      ["استغاثات SOS", "1"],
      ["حرائق نشطة", "2"],
      ["مؤكدة", "1"],
      ["أقمار صناعية", "0"],
      ["متصل الآن", "3"],
      ["الحماية المدنية", "0/0"],
      ["فرق المتطوعين", "0/0"],
    ];
    const grid = screen.getByText("استغاثات SOS").parentElement!.parentElement!.parentElement!;
    expect(grid.children).toHaveLength(7);
    for (const [label, count] of expectedCards) {
      const card = screen.getByText(label).parentElement!.parentElement!;
      expect(within(card).getByText((_content, element) =>
        element?.tagName === "P" && element.classList.contains("text-2xl") && element.textContent === count
      )).toBeTruthy();
    }
    const online = screen.getByText("متصل الآن").parentElement!.parentElement!;
    expect(within(online).getByText("1 متطوع | 1 رسمي")).toBeTruthy();
  });
});
