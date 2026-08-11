import { describe, it, expect } from "vitest";
import { isEscalation, SEVERITY_RANK } from "../src/hooks/useProximityAlerts.js";

describe("isEscalation — shared alert escalation rule", () => {
  it("treats a first sighting as an alert (nothing previously announced)", () => {
    expect(isEscalation(undefined, "medium")).toBe(true);
  });

  it("does NOT re-alert when severity stays the same", () => {
    expect(isEscalation("high", "high")).toBe(false);
  });

  it("re-alerts when severity rises (high → critical)", () => {
    expect(isEscalation("high", "critical")).toBe(true);
  });

  it("does NOT re-alert when severity drops (critical → medium)", () => {
    expect(isEscalation("critical", "medium")).toBe(false);
  });

  it("treats a first sighting with an unknown severity as an alert", () => {
    expect(isEscalation(undefined, "extreme-unknown")).toBe(true);
  });

  it("does NOT escalate to an unknown severity below every known rank", () => {
    expect(isEscalation("high", "extreme-unknown")).toBe(false);
  });

  it("never alerts on a missing next severity", () => {
    expect(isEscalation("critical", undefined)).toBe(false);
  });

  it("orders severities monotonically (low < medium < high < critical)", () => {
    expect(SEVERITY_RANK.low).toBeLessThan(SEVERITY_RANK.medium);
    expect(SEVERITY_RANK.medium).toBeLessThan(SEVERITY_RANK.high);
    expect(SEVERITY_RANK.high).toBeLessThan(SEVERITY_RANK.critical);
  });
});
