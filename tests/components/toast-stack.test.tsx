// @vitest-environment jsdom
/**
 * Fix 30 (TST-1): toasts are the only feedback for several actions
 * (report sent, confirmation failed) — the container must be a live
 * region so screen readers announce them. No focus change: focus theft
 * on a transient, auto-dismissing element is the wrong fix.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ToastStack, { type ToastItem } from "../../src/components/ui/ToastStack";

function toast(id: string, message: string, type: ToastItem["type"] = "error"): ToastItem {
  return { id, message, type };
}

describe("ToastStack live region (Fix 30 TST-1)", () => {
  it("toasts live inside a polite status region", () => {
    render(<ToastStack toasts={[toast("1", "تعذّر تأكيد البلاغ", "error")]} />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.contains(screen.getByText("تعذّر تأكيد البلاغ"))).toBe(true);
  });

  it("a second toast appended later is inside the same live region", () => {
    const { rerender } = render(<ToastStack toasts={[toast("1", "تم إرسال البلاغ", "success")]} />);
    rerender(
      <ToastStack
        toasts={[toast("1", "تم إرسال البلاغ", "success"), toast("2", "تعذّر تأكيد البلاغ", "error")]}
      />,
    );
    const region = screen.getByRole("status");
    expect(region.contains(screen.getByText("تم إرسال البلاغ"))).toBe(true);
    expect(region.contains(screen.getByText("تعذّر تأكيد البلاغ"))).toBe(true);
  });

  it("an empty list still renders the (empty) live region (Fix 30b)", () => {
    const { container } = render(<ToastStack toasts={[]} />);
    // Fix 30b: the region must exist BEFORE any toast arrives, or screen
    // readers can miss the first toast. Empty means no toast messages,
    // not no region.
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    expect(container.querySelector("[role='status']")).toBe(region);
  });

  it("a toast arriving after an empty interval lands inside the already-mounted region (Fix 30b)", () => {
    const { rerender } = render(<ToastStack toasts={[]} />);
    const region = screen.getByRole("status");
    rerender(<ToastStack toasts={[toast("1", "تم إرسال البلاغ", "success")]} />);
    // Same region element (not a fresh mount in the same commit as the
    // message) — that is what makes the announcement fire reliably.
    expect(screen.getByRole("status")).toBe(region);
    expect(region.contains(screen.getByText("تم إرسال البلاغ"))).toBe(true);
  });
});
