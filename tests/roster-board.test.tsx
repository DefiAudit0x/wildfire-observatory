import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import RosterBoard from "../src/components/RosterBoard.js";

// Fix 15b: a failed roster load used to install an editable empty roster,
// and saving it after the DB recovered replaced the real day. The board must
// leave the roster unavailable (null + load error) instead.
vi.mock("../src/hooks/useAuth.js", () => ({
  useStaffSession: () => ({
    session: { authenticated: true, role: "commander", unitId: "DZ16", name: "Test", agentId: "t-commander" },
    refetch: vi.fn(),
    loading: false,
  }),
}));

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RosterBoard failed load (Fix 15b)", () => {
  it("shows a load error and keeps save disabled instead of an editable empty roster", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roster/")) {
          return new Response(JSON.stringify({ error: "Database not available" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("تعذر تحميل الجدول.")).toBeTruthy());
    // No empty-roster hint: the board must not present a day that was never loaded.
    expect(screen.queryByText(/لا توجد مناصب مسجلة/)).toBeNull();
    // Save stays disabled while no roster is loaded.
    const saveButton = screen.getByText("حفظ جدول اليوم").closest("button");
    expect(saveButton).not.toBeNull();
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("loads and shows the saved roster when the read succeeds (control)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roster/")) {
          return new Response(
            JSON.stringify({
              unitId: "unit-dz16",
              date: todayISO(),
              posts: [{ id: "p1", labelAr: "منصب", status: "active", personnel: [] }],
              saved: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    expect(screen.queryByText("تعذر تحميل الجدول.")).toBeNull();
    const saveButton = screen.getByText("حفظ جدول اليوم").closest("button");
    expect(saveButton).not.toBeNull();
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  // Fix 15c: the failed-load protection must also cover a roster that was
  // already loaded. A refetch that fails must clear it — otherwise the stale
  // day stays editable and Save re-enables once loading clears.
  it("clears a previously loaded roster when the next load returns 503", async () => {
    let rosterCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roster/")) {
          rosterCalls += 1;
          if (rosterCalls === 1) {
            return new Response(
              JSON.stringify({
                unitId: "unit-dz16",
                date: todayISO(),
                posts: [{ id: "p1", labelAr: "منصب", status: "active", personnel: [] }],
                saved: true,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ error: "Database not available" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    fireEvent.click(screen.getByTitle("اليوم التالي"));
    await waitFor(() => expect(screen.getByText("تعذر تحميل الجدول.")).toBeTruthy());
    expect(screen.queryByText("منصب")).toBeNull();
    const saveButton = screen.getByText("حفظ جدول اليوم").closest("button");
    expect(saveButton).not.toBeNull();
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears a previously loaded roster when the next load throws", async () => {
    let rosterCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roster/")) {
          rosterCalls += 1;
          if (rosterCalls === 1) {
            return new Response(
              JSON.stringify({
                unitId: "unit-dz16",
                date: todayISO(),
                posts: [{ id: "p1", labelAr: "منصب", status: "active", personnel: [] }],
                saved: true,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          throw new Error("network down");
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    fireEvent.click(screen.getByTitle("اليوم التالي"));
    await waitFor(() => expect(screen.getByText("تعذر تحميل الجدول.")).toBeTruthy());
    expect(screen.queryByText("منصب")).toBeNull();
    const saveButton = screen.getByText("حفظ جدول اليوم").closest("button");
    expect(saveButton).not.toBeNull();
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });
});
