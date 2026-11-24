// @vitest-environment jsdom
// First test ever to render the full App (Fix 48 — NHTMLCONT-1).
// The fetch mock answers every poll endpoint so the mount stays quiet;
// the language assertions do not depend on any data.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import App from "../src/App";

const fetchMock = vi.fn(async (url: string) => {
  const isList =
    url.includes("/api/reports") ||
    url.includes("/api/satellite-data") ||
    url.includes("/api/wilayas") ||
    url.includes("/api/sos");
  return {
    ok: true,
    status: 200,
    json: async () => (isList ? [] : {}),
    text: async () => "",
  };
});

describe("document language (Fix 48 — NHTMLCONT-1)", () => {
  beforeEach(() => {
    // document.documentElement.lang is SHARED across tests in this file
    // (one jsdom document) — reset it, never assume the previous value.
    // jsdom does not load index.html, so the initial value is "" here,
    // not the "ar" the shell declares.
    document.documentElement.lang = "";
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.lang = "";
  });

  it("declares Arabic on initial mount (finding)", async () => {
    render(<App />);
    await act(async () => {});
    expect(document.documentElement.lang).toBe("ar");
  });

  it("declares French after toggling to French (finding)", async () => {
    const { unmount } = render(<App />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Français" }));
    });
    expect(document.documentElement.lang).toBe("fr");
    unmount();
  });

  it("declares Arabic again after toggling back (finding)", async () => {
    const { unmount } = render(<App />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Français" }));
    });
    expect(document.documentElement.lang).toBe("fr");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "العربية" }));
    });
    expect(document.documentElement.lang).toBe("ar");
    unmount();
  });
});
