/**
 * Fix 39 (FRM-1): the report form's visible labels were not associated with
 * their controls — a bare <label> with no htmlFor and a control with no id.
 * No existing test renders ReportForm (coverage was hook-level), so this
 * file mounts the component itself, with the same offlineDraftStore /
 * badgeStore mocks as report-form-hooks.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ReportForm from "../../src/components/ReportForm";

vi.mock("../../src/utils/offlineDraftStore", () => ({
  loadOfflineDrafts: vi.fn(),
  replaceOfflineDrafts: vi.fn(),
  removeOfflineDrafts: vi.fn(),
}));

vi.mock("../../src/utils/badgeStore", () => ({
  setReporterBadge: vi.fn(),
}));

import {
  loadOfflineDrafts,
  replaceOfflineDrafts,
  removeOfflineDrafts,
} from "../../src/utils/offlineDraftStore";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadOfflineDrafts).mockResolvedValue([]);
  vi.mocked(replaceOfflineDrafts).mockImplementation(async (records) => records);
  vi.mocked(removeOfflineDrafts).mockResolvedValue(undefined);
  // Safety net: no mount-time fetch is expected (the reverse-geocode effect
  // fires only once coordinates parse), but a stray call must not throw.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountForm() {
  render(<ReportForm mapClickedCoords={null} onSubmit={async () => {}} lang="ar" />);
}

describe("ReportForm labels (Fix 39 — FRM-1)", () => {
  it("every visible field is labelled (and the badge field after switching roles)", () => {
    mountForm();
    expect(screen.getByLabelText(/خط العرض/)).toBeInTheDocument();
    expect(screen.getByLabelText(/خط الطول/)).toBeInTheDocument();
    expect(screen.getByLabelText("الولاية")).toBeInTheDocument();
    expect(screen.getByLabelText(/اسم التجمع السكني/)).toBeInTheDocument();
    expect(screen.getByLabelText(/الوصف التفصيلي/)).toBeInTheDocument();
    expect(screen.getByLabelText(/الاسم الكامل/)).toBeInTheDocument();
    expect(screen.getByLabelText(/رقم الهاتف/)).toBeInTheDocument();
    // The badge field is hidden by default (reporterType defaults to
    // "citizen") — reveal it with the volunteer role button first.
    fireEvent.click(screen.getByRole("button", { name: /متطوع معتمد/ }));
    expect(screen.getByLabelText(/رمز اعتماد/)).toBeInTheDocument();
  });

  it("each label names its control (the association a click uses)", () => {
    // Probed: this jsdom does NOT move focus on a label click (even for a
    // plain label+input), so the click-focus behavior is unprovable here.
    // The label's .control property IS the association the browser's
    // click-to-focus runs on — asserting it pins the same wiring.
    mountForm();
    const latLabel = screen.getByText(/خط العرض/) as HTMLLabelElement;
    expect(latLabel.control).toBe(screen.getByLabelText(/خط العرض/));
    const wilayaLabel = screen.getByText("الولاية") as HTMLLabelElement;
    expect(wilayaLabel.control).toBe(screen.getByLabelText("الولاية"));
  });
});
