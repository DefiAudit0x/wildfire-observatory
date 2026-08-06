import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
