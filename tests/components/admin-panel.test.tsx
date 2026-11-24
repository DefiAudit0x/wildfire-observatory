import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AdminPanel from "../../src/components/AdminPanel";

describe("AdminPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 401, headers: { "Content-Type": "application/json" } }))
    );
  });

  // --- Fix 32 (ADM-3 / ADM-4) ---

  function makeReport(i: number) {
    return {
      id: `r-${i}`,
      status: "pending" as const,
      severity: "high" as const,
      lat: 36.8,
      lng: 7.5,
      locationName: `Test ${i}`,
      wilaya: "test",
      description: "test",
      timestamp: new Date().toISOString(),
      consensusCount: 1,
      reporterType: "citizen" as const,
    };
  }

  function authFetchMock(overrides: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const hit = overrides(url, init);
      if (hit) return hit;
      if (url === "/api/admin/session") return new Response("{}", { status: 200 });
      return new Response("{}", { status: 404 });
    });
  }

  it("ADM-3: a failed logout keeps the operator logged in and shows an error", async () => {
    const fetchMock = authFetchMock((url) => {
      if (url === "/api/admin/logout") return Promise.reject(new Error("network down"));
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPanel reports={[makeReport(1)]} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "خروج" }));
    await waitFor(() => expect(screen.getByText(/تعذّر تسجيل الخروج/i)).toBeInTheDocument());
    // Still authenticated: stats visible, login form absent.
    expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/كلمة المرور/i)).not.toBeInTheDocument();
  });

  it("ADM-3: a logout HTTP 500 keeps the operator logged in", async () => {
    const fetchMock = authFetchMock((url) => {
      if (url === "/api/admin/logout") return new Response("{}", { status: 500 });
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPanel reports={[makeReport(1)]} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "خروج" }));
    await waitFor(() => expect(screen.getByText(/تعذّر تسجيل الخروج/i)).toBeInTheDocument());
    expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/كلمة المرور/i)).not.toBeInTheDocument();
  });

  it("ADM-3: a successful logout switches to the login surface, exactly one POST", async () => {
    const fetchMock = authFetchMock((url) => {
      if (url === "/api/admin/logout") return new Response("{}", { status: 200 });
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPanel reports={[makeReport(1)]} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "خروج" }));
    expect(await screen.findByText(/لوحة تحكم المشرفين الأمنية/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/admin/logout")).toHaveLength(1);
  });

  it("ADM-3 (32b Nitpick 2): the logout button is disabled while the request is pending and a second click issues no second POST", async () => {
    let resolveLogout!: (res: Response) => void;
    const logoutGate = new Promise<Response>((resolve) => {
      resolveLogout = resolve;
    });
    const fetchMock = authFetchMock((url) => {
      if (url === "/api/admin/logout") return logoutGate;
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPanel reports={[makeReport(1)]} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument());
    const logoutButton = screen.getByRole("button", { name: "خروج" });
    fireEvent.click(logoutButton);
    await waitFor(() => expect(logoutButton).toBeDisabled());
    expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument();
    fireEvent.click(logoutButton);
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/admin/logout")).toHaveLength(1);
    resolveLogout(new Response("{}", { status: 200 }));
    expect(await screen.findByText(/لوحة تحكم المشرفين الأمنية/i)).toBeInTheDocument();
  });

  it("ADM-3 (32b Nitpick 2): a rejected pending logout re-enables the button and keeps the operator logged in", async () => {
    let rejectLogout!: (err: Error) => void;
    const logoutGate = new Promise<Response>((_resolve, reject) => {
      rejectLogout = reject;
    });
    const fetchMock = authFetchMock((url) => {
      if (url === "/api/admin/logout") return logoutGate;
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPanel reports={[makeReport(1)]} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument());
    const logoutButton = screen.getByRole("button", { name: "خروج" });
    fireEvent.click(logoutButton);
    await waitFor(() => expect(logoutButton).toBeDisabled());
    rejectLogout(new Error("network down"));
    await waitFor(() => expect(screen.getByText(/تعذّر تسجيل الخروج/i)).toBeInTheDocument());
    expect(logoutButton).toBeEnabled();
    expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument();
  });

  it("ADM-3: a session-expiry logout fires no logout POST", async () => {
    const fetchMock = authFetchMock((url) => {
      if (url === "/api/admin/reports/r-1/delete") return new Response("{}", { status: 401 });
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPanel reports={[makeReport(1)]} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "حذف" }));
    fireEvent.click(screen.getByRole("button", { name: "حذف نهائياً" }));
    expect(await screen.findByText(/لوحة تحكم المشرفين الأمنية/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/admin/logout")).toHaveLength(0);
  });

  it("ADM-4: shrinking the list then Previous reaches the earlier page", async () => {
    const fetchMock = authFetchMock(() => null);
    vi.stubGlobal("fetch", fetchMock);
    const reports45 = Array.from({ length: 45 }, (_, i) => makeReport(i + 1));
    const { rerender } = render(<AdminPanel reports={reports45} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "التالي" }));
    fireEvent.click(screen.getByRole("button", { name: "التالي" }));
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    // Deletion/refresh shrinks the list to 2 pages; the state clamps to 2.
    const reports40 = reports45.slice(0, 40);
    rerender(<AdminPanel reports={reports40} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText("2 / 2")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "السابق" }));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("ADM-4: Next from the last page stays put (control)", async () => {
    const fetchMock = authFetchMock(() => null);
    vi.stubGlobal("fetch", fetchMock);
    const reports45 = Array.from({ length: 45 }, (_, i) => makeReport(i + 1));
    render(<AdminPanel reports={reports45} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "التالي" }));
    fireEvent.click(screen.getByRole("button", { name: "التالي" }));
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "التالي" }));
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
  });

  it("shows login form when not authenticated", async () => {
    render(<AdminPanel reports={[]} onRefresh={() => {}} lang="ar" />);
    expect(await screen.findByText(/لوحة تحكم المشرفين الأمنية/i)).toBeInTheDocument();
  });

  it("shows password input field", async () => {
    render(<AdminPanel reports={[]} onRefresh={() => {}} lang="fr" />);
    const input = await screen.findByPlaceholderText(/Mot de passe/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("displays statistics when authenticated", async () => {
    const reports = [
      { id: "1", status: "pending" as const, severity: "high" as const, lat: 36.8, lng: 7.5, locationName: "Test", wilaya: "test", description: "test", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen" as const },
      { id: "2", status: "verified" as const, severity: "critical" as const, lat: 36.8, lng: 7.5, locationName: "Test2", wilaya: "test", description: "test", timestamp: new Date().toISOString(), consensusCount: 5, reporterType: "official" as const, reporterBadgeCode: "123" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { "Content-Type": "application/json" } }))
    );
    render(<AdminPanel reports={reports} onRefresh={() => {}} lang="ar" />);
    await waitFor(() => expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument());
    expect(screen.getByText(/بلاغات قيد المراجعة/i)).toBeInTheDocument();
    expect(screen.getByText(/بلاغات موثقة/i)).toBeInTheDocument();
  });

  it("loads private reporter identity for display, search, phone and CSV after the admin session probe", async () => {
    const report = { id: "private-1", status: "pending" as const, severity: "high" as const, lat: 36.8, lng: 7.5, locationName: "Test forest", wilaya: "Annaba", description: "Test fire report", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen" as const };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/admin/session") return new Response("{}", { status: 200 });
      if (url === "/api/reports/private-1/identity") {
        return new Response(JSON.stringify({ reporterName: "Amina Reporter", reporterPhone: "+213555010203" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn((_blob: Blob) => "blob:test");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { unmount } = render(<AdminPanel reports={[report]} onRefresh={() => {}} lang="fr" />);
    expect(await screen.findByText("Amina Reporter (citizen)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "+213555010203" })).toHaveAttribute("href", "tel:+213555010203");
    const search = screen.getByPlaceholderText(/Rechercher/i);
    fireEvent.change(search, { target: { value: "Amina Reporter" } });
    expect(screen.getByText("Amina Reporter (citizen)")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "Someone else" } });
    expect(screen.queryByText("Amina Reporter (citizen)")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /CSV/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(csv).toContain("Amina Reporter");
    expect(click).toHaveBeenCalledTimes(1);
    unmount();

    const unauthenticatedFetch = vi.fn(async (_input: string | URL | Request) => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", unauthenticatedFetch);
    render(<AdminPanel reports={[report]} onRefresh={() => {}} lang="fr" />);
    await screen.findByPlaceholderText(/Mot de passe/i);
    expect(unauthenticatedFetch).toHaveBeenCalledTimes(1);
    expect(unauthenticatedFetch.mock.calls[0][0]).toBe("/api/admin/session");
    expect(screen.queryByText(/Amina Reporter/)).not.toBeInTheDocument();
  });

  it("disables the CSV export while reporter identities are loading, then enables it (Fix 8b)", async () => {
    const report = { id: "private-1", status: "pending" as const, severity: "high" as const, lat: 36.8, lng: 7.5, locationName: "Test forest", wilaya: "Annaba", description: "Test fire report", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen" as const };
    let resolveIdentity!: (res: Response) => void;
    const identityPromise = new Promise<Response>((resolve) => {
      resolveIdentity = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/admin/session") return new Response("{}", { status: 200 });
      if (url === "/api/reports/private-1/identity") return identityPromise;
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPanel reports={[report]} onRefresh={() => {}} lang="fr" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /CSV/i })).toBeDisabled()
    );
    resolveIdentity(
      new Response(JSON.stringify({ reporterName: "Amina Reporter", reporterPhone: "+213555010203" }), { status: 200 })
    );
    expect(await screen.findByText("Amina Reporter (citizen)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /CSV/i })).toBeEnabled();
  });

  it("neutralizes spreadsheet formulas in the CSV export (Fix 8b, CWE-1236)", async () => {
    const report = { id: "private-1", status: "pending" as const, severity: "high" as const, lat: 36.8, lng: 7.5, locationName: "@mention", wilaya: "Annaba", description: "=HYPERLINK(\"http://evil.test\")", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen" as const };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/admin/session") return new Response("{}", { status: 200 });
      if (url === "/api/reports/private-1/identity") {
        return new Response(JSON.stringify({ reporterName: "=2+3", reporterPhone: "+213555010203" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn((_blob: Blob) => "blob:test");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<AdminPanel reports={[report]} onRefresh={() => {}} lang="fr" />);
    expect(await screen.findByText("=2+3 (citizen)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /CSV/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    // The shared csvCell guard prefixes formula-leading text with an apostrophe.
    expect(csv).toContain("'=2+3");
    expect(csv).toContain("'@mention");
    expect(csv).toContain("'=HYPERLINK");
    // ...and the old unguarded quoted forms must be gone.
    expect(csv).not.toContain('"=2+3"');
    expect(csv).not.toContain('"@mention"');
    expect(click).toHaveBeenCalledTimes(1);
  });
});
