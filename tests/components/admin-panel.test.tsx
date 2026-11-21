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
