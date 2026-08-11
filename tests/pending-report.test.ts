/**
 * Audit round: the CitizenReportPayload union types are compile-time only —
 * the payload arrives at the boundary as DATA. buildLocalPendingReport must
 * coerce out-of-schema values at runtime, never cast them through.
 */
import { describe, it, expect } from "vitest";
import { buildLocalPendingReport, CitizenReportPayload } from "../src/hooks/useObservatoryData.js";

/** Simulates the untrusted runtime boundary (form → JS bridge → JSON). */
const asUntrustedPayload = (overrides: Record<string, unknown>): CitizenReportPayload =>
  JSON.parse(
    JSON.stringify({
      lat: 36.75,
      lng: 7.45,
      locationName: "Test",
      wilaya: "Annaba (Annaba)",
      description: "test",
      ...overrides,
    })
  ) as CitizenReportPayload;

describe("buildLocalPendingReport — runtime schema boundary", () => {
  it("coerces an out-of-schema severity to the default instead of casting it through", () => {
    expect(buildLocalPendingReport(asUntrustedPayload({ severity: "nuclear" })).severity).toBe("medium");
  });

  it("accepts every schema severity verbatim", () => {
    for (const sev of ["low", "medium", "high", "critical"]) {
      expect(buildLocalPendingReport(asUntrustedPayload({ severity: sev })).severity).toBe(sev);
    }
  });

  it("defaults to medium when severity is absent", () => {
    expect(buildLocalPendingReport(asUntrustedPayload({})).severity).toBe("medium");
  });

  it("keeps non-finite coordinates as NaN markers (never a silent 0,0)", () => {
    const report = buildLocalPendingReport(asUntrustedPayload({ lat: "abc" }));
    expect(Number.isNaN(report.lat)).toBe(true);
    expect(report.lng).toBe(7.45);
  });

  it("preserves the client id and marks the report pending (offline/mesh contract)", () => {
    const report = buildLocalPendingReport(asUntrustedPayload({ clientGeneratedId: "abc-123" }));
    expect(report.id).toBe("abc-123");
    expect(report.status).toBe("pending");
  });
});
