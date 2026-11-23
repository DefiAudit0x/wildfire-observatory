// @vitest-environment jsdom
/**
 * Fix 30 (DLG-1): the confirmation dialog's visible heading is its
 * accessible name — screen-reader dialog navigation must be able to
 * identify which confirmation this is.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ConfirmDialog from "../../src/components/ui/ConfirmDialog";

function renderDialog(open: boolean) {
  return render(
    <ConfirmDialog
      open={open}
      title="حذف الشارة"
      message="هل أنت متأكد من حذف هذه الشارة؟"
      confirmLabel="حذف"
      onConfirm={() => {}}
      onCancel={() => {}}
      lang="ar"
    />,
  );
}

describe("ConfirmDialog accessible name (Fix 30 DLG-1)", () => {
  it("the dialog is named by its visible title", () => {
    renderDialog(true);
    const dialog = screen.getByRole("dialog", { name: "حذف الشارة" });
    expect(dialog.getAttribute("aria-labelledby")).toBe("confirm-dialog-title");
    expect(screen.getByText("حذف الشارة").id).toBe("confirm-dialog-title");
  });

  it("a closed dialog renders nothing", () => {
    const { container } = renderDialog(false);
    expect(container.innerHTML).toBe("");
  });
});
