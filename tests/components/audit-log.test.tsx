// @vitest-environment jsdom
/**
 * Fix 32 (AUD-1): an audit-load failure used to render exactly like an
 * empty trail ("No actions recorded") — the operator could not tell
 * "nothing happened" from "the log is unreachable". A failed load now
 * renders an error banner; a failed refresh keeps the old entries visible
 * under a banner instead of silently going stale.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AuditLog from "../../src/components/admin/AuditLog";

function entry(i: number) {
  return {
    id: `audit-${i}`,
    action: `custom-${i}`,
    details: {},
    timestamp: new Date().toISOString(),
  };
}

describe("AuditLog load errors (Fix 32 AUD-1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an HTTP 500 renders an error, not the empty message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    render(<AuditLog lang="ar" onAuthError={() => false} />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("تعذّر تحميل سجل التدقيق (خطأ 500)")
    );
    expect(screen.queryByText("لا توجد إجراءات مسجلة بعد.")).not.toBeInTheDocument();
  });

  it("a transport failure renders an error, not the empty message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));
    render(<AuditLog lang="ar" onAuthError={() => false} />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("تعذّر تحميل سجل التدقيق — تحقق من الاتصال")
    );
    expect(screen.queryByText("لا توجد إجراءات مسجلة بعد.")).not.toBeInTheDocument();
  });

  it("a failed refresh keeps old entries under a banner", async () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry(i));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(entries), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuditLog lang="ar" onAuthError={() => false} />);
    await waitFor(() => expect(screen.getByText("custom-0")).toBeInTheDocument());
    // The refresh now fails.
    fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "تحديث" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("تعذّر تحميل سجل التدقيق (خطأ 500)")
    );
    expect(screen.getByText("custom-0")).toBeInTheDocument();
  });

  it("a successful load of an empty trail shows the empty message with no banner (control)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    render(<AuditLog lang="ar" onAuthError={() => false} />);
    expect(await screen.findByText("لا توجد إجراءات مسجلة بعد.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a successful retry after a failure clears the banner (control)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuditLog lang="ar" onAuthError={() => false} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([entry(0)]), { status: 200 }));
    fireEvent.click(screen.getByRole("button", { name: "تحديث" }));
    await waitFor(() => expect(screen.getByText("custom-0")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
