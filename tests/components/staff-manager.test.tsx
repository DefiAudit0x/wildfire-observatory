import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import StaffManager from "../../src/components/admin/StaffManager.js";

// Fix 33 (STF-1): the canned session varies per case — admin / superadmin /
// commander / agent — so the mock reads a module-level mutable session.
const mockSession = vi.hoisted(() => ({
  current: { authenticated: true, role: "admin", unitId: null as string | null, name: "إداري", agentId: "SESS-1" },
}));

vi.mock("../../src/hooks/useAuth.js", () => ({
  useStaffSession: () => ({
    session: mockSession.current,
    refetch: vi.fn(),
    loading: false,
  }),
}));

const units = [{ id: "u1", code: "DZ16", nameAr: "وحدة عنابة", nameFr: "Unité Annaba", wilaya: "عنابة" }];

const users = [
  { agentId: "AG-16", name: "وكيل 16", role: "agent", unitId: "DZ16", isActive: true },
  { agentId: "AG-23", name: "وكيل 23", role: "agent", unitId: "DZ23", isActive: true },
  { agentId: "SA-01", name: "مشرف", role: "superadmin", unitId: "DZ16", isActive: true },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/units")) {
        return new Response(JSON.stringify({ units }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("/api/users")) {
        return new Response(JSON.stringify({ users }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 404, headers: { "Content-Type": "application/json" } });
    })
  );
}

function setSession(role: string, unitId: string | null) {
  mockSession.current = { authenticated: true, role, unitId, name: "مختبَر", agentId: "SESS-1" };
}

async function renderWithSession(role: string, unitId: string | null) {
  setSession(role, unitId);
  stubFetch();
  const utils = render(<StaffManager lang="ar" />);
  await waitFor(() => expect(screen.getByText("AG-16")).toBeTruthy());
  return utils;
}

function rowFor(agentId: string): Element {
  const row = screen.getByText(agentId).closest('[class*="bg-gray-800"]');
  if (!row) throw new Error(`row for ${agentId} not found`);
  return row;
}

function roleSelect(): HTMLSelectElement {
  const selects = document.querySelectorAll("select");
  if (selects.length === 0) throw new Error("no select found (create form missing?)");
  return selects[0] as HTMLSelectElement;
}

describe("StaffManager role matrix (Fix 33 — STF-1)", () => {
  it("admin session: no superadmin option, units kept, delete/toggle only on non-superadmin rows, admin label", async () => {
    await renderWithSession("admin", null);
    // Units section stays for admin (the server allows admin on units).
    expect(screen.getByText("إدارة وحدات الحماية المدنية")).toBeTruthy();
    // The superadmin option is not offered to a plain admin.
    expect(roleSelect().querySelector('option[value="superadmin"]')).toBeNull();
    // Delete + toggle on the agent row, neither on the superadmin row.
    expect(rowFor("AG-16").querySelector('button[title="حذف الحساب"]')).not.toBeNull();
    expect(rowFor("AG-16").querySelector('button[title="تفعيل / إيقاف"]')).not.toBeNull();
    expect(rowFor("SA-01").querySelector('button[title="حذف الحساب"]')).toBeNull();
    expect(rowFor("SA-01").querySelector('button[title="تفعيل / إيقاف"]')).toBeNull();
    // The header no longer overclaims full central access for an admin.
    expect(screen.getByText("إدارة عامة — دون حسابات المشرف العام")).toBeTruthy();
    expect(screen.queryByText("صلاحيات مركزية كاملة")).toBeNull();
  });

  it("superadmin session: superadmin option present, delete + toggle on every row, full-access label (control)", async () => {
    await renderWithSession("superadmin", null);
    expect(roleSelect().querySelector('option[value="superadmin"]')).not.toBeNull();
    expect(rowFor("AG-16").querySelector('button[title="حذف الحساب"]')).not.toBeNull();
    expect(rowFor("SA-01").querySelector('button[title="حذف الحساب"]')).not.toBeNull();
    expect(rowFor("SA-01").querySelector('button[title="تفعيل / إيقاف"]')).not.toBeNull();
    expect(screen.getByText("صلاحيات مركزية كاملة")).toBeTruthy();
  });

  it("commander session (DZ16): toggle only on own-unit agents, no delete anywhere, no superadmin option", async () => {
    await renderWithSession("commander", "DZ16");
    expect(roleSelect().querySelector('option[value="superadmin"]')).toBeNull();
    expect(rowFor("AG-16").querySelector('button[title="تفعيل / إيقاف"]')).not.toBeNull();
    expect(rowFor("AG-23").querySelector('button[title="تفعيل / إيقاف"]')).toBeNull();
    expect(rowFor("SA-01").querySelector('button[title="تفعيل / إيقاف"]')).toBeNull();
    expect(rowFor("AG-16").querySelector('button[title="حذف الحساب"]')).toBeNull();
    expect(rowFor("SA-01").querySelector('button[title="حذف الحساب"]')).toBeNull();
    expect(screen.getByText("(وحدتك فقط)")).toBeTruthy();
  });

  it("agent session: no create form, no toggle/delete on any row", async () => {
    setSession("agent", "DZ16");
    stubFetch();
    render(<StaffManager lang="ar" />);
    await waitFor(() => expect(screen.getByText("AG-16")).toBeTruthy());
    expect(document.querySelectorAll("select").length).toBe(0);
    expect(screen.queryByTitle("تفعيل / إيقاف")).toBeNull();
    expect(screen.queryByTitle("حذف الحساب")).toBeNull();
  });

  it("admin session still sees the units section but a commander does not", async () => {
    await renderWithSession("commander", "DZ16");
    expect(screen.queryByText("إدارة وحدات الحماية المدنية")).toBeNull();
  });
});

describe("StaffManager logout timeout (CodeRabbit PR #215, R2-#4)", () => {
  it("logout rides the 15 s apiFetch ceiling", async () => {
    setSession("admin", null);
    const fetchMock = vi.fn(async (url: string, _init?: any) => {
      if (String(url).includes("/api/units")) {
        return new Response(JSON.stringify({ units }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("/api/users")) {
        return new Response(JSON.stringify({ users }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("/logout")) {
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<StaffManager lang="ar" />);
    await waitFor(() => expect(screen.getByText("AG-16")).toBeTruthy());
    fireEvent.click(screen.getByText("خروج"));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/logout"));
      expect(calls.length).toBe(2);
    });
    // apiFetch passes an AbortSignal.timeout(15_000); bare fetch() passes
    // no signal at all, so these assertions fail on the pre-fix code.
    const logoutCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/logout"));
    expect(logoutCalls.map(([url]) => String(url)).sort()).toEqual([
      "/api/admin/logout",
      "/api/auth/logout",
    ]);
    for (const [, init] of logoutCalls) {
      expect((init as any)?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
