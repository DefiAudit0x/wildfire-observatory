import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminPanel from "../../src/components/AdminPanel";

describe("AdminPanel", () => {
  it("shows login form when not authenticated", () => {
    render(<AdminPanel reports={[]} onRefresh={() => {}} lang="ar" />);
    expect(screen.getByText(/لوحة تحكم المشرفين الأمنية/i)).toBeInTheDocument();
  });

  it("shows password input field", () => {
    render(<AdminPanel reports={[]} onRefresh={() => {}} lang="fr" />);
    const input = screen.getByPlaceholderText(/Mot de passe/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("displays statistics when authenticated", () => {
    const reports = [
      { id: "1", status: "pending" as const, severity: "high" as const, lat: 36.8, lng: 7.5, locationName: "Test", wilaya: "test", description: "test", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen" as const },
      { id: "2", status: "verified" as const, severity: "critical" as const, lat: 36.8, lng: 7.5, locationName: "Test2", wilaya: "test", description: "test", timestamp: new Date().toISOString(), consensusCount: 5, reporterType: "official" as const, reporterBadgeCode: "123" },
    ];
    sessionStorage.setItem("admin_authenticated", "true");
    sessionStorage.setItem("admin_password", "test-pass");
    render(<AdminPanel reports={reports} onRefresh={() => {}} lang="ar" />);
    expect(screen.getByText(/إجمالي البلاغات/i)).toBeInTheDocument();
    expect(screen.getByText(/بلاغات قيد المراجعة/i)).toBeInTheDocument();
    expect(screen.getByText(/بلاغات موثقة/i)).toBeInTheDocument();
    sessionStorage.clear();
  });
});
