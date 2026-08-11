import { describe, it, expect } from "vitest";
import { Report } from "../src/types";
import {
  isEscalation,
  SEVERITY_RANK,
  computeNewAlerts,
  isReportEligibleForAlert,
} from "../src/hooks/useProximityAlerts.js";

describe("isReportEligibleForAlert — the observatory's ONE alert-eligibility policy", () => {
  // Status values arrive as untrusted DATA at the boundary — the runtime
  // check must answer for out-of-schema values too ("nuclear").
  const withStatus = (status: string): Pick<Report, "status"> =>
    ({ status }) as Pick<Report, "status">;

  it("proximity-siren admits VERIFIED reports only (matches the UI's verified-only copy)", () => {
    expect(isReportEligibleForAlert(withStatus("verified"), "proximity-siren")).toBe(true);
    expect(isReportEligibleForAlert(withStatus("pending"), "proximity-siren")).toBe(false);
    expect(isReportEligibleForAlert(withStatus("rejected"), "proximity-siren")).toBe(false);
    expect(isReportEligibleForAlert(withStatus("resolved"), "proximity-siren")).toBe(false);
  });

  it("operator-tone admits verified AND pending (earliest-signal policy for staff)", () => {
    expect(isReportEligibleForAlert(withStatus("verified"), "operator-tone")).toBe(true);
    expect(isReportEligibleForAlert(withStatus("pending"), "operator-tone")).toBe(true);
    expect(isReportEligibleForAlert(withStatus("rejected"), "operator-tone")).toBe(false);
    expect(isReportEligibleForAlert(withStatus("resolved"), "operator-tone")).toBe(false);
  });

  it("rejects unknown statuses on both channels", () => {
    expect(isReportEligibleForAlert(withStatus("nuclear"), "proximity-siren")).toBe(false);
    expect(isReportEligibleForAlert(withStatus("nuclear"), "operator-tone")).toBe(false);
  });
});

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

describe("computeNewAlerts — announcement set vs announced memory", () => {
  const r = (id: string, severity: string) => ({ id, severity });

  it("announces everything on an empty memory (first scan)", () => {
    expect(computeNewAlerts(new Map(), [r("a", "low"), r("b", "critical")])).toEqual([
      r("a", "low"),
      r("b", "critical"),
    ]);
  });

  it("announces only escalated reports on a warm memory", () => {
    const memory = new Map([
      ["a", "high"],
      ["b", "critical"],
    ]);
    expect(
      computeNewAlerts(memory, [r("a", "critical"), r("b", "critical"), r("c", "high")])
    ).toEqual([r("a", "critical"), r("c", "high")]);
  });

  it("excludes reports that returned to a previously ANNOUNCED level", () => {
    // critical→high was announced; dropping to medium then rising back to high
    // must NOT re-alert (the memory was never rewritten by the downgrade).
    const memory = new Map([["a", "high"]]);
    expect(computeNewAlerts(memory, [r("a", "high"), r("a", "medium")])).toEqual([]);
    expect(computeNewAlerts(memory, [r("a", "high")])).toEqual([]);
  });

  it("re-alerts on the high→critical escalation after a prior downgrade", () => {
    const memory = new Map([["a", "high"]]);
    expect(computeNewAlerts(memory, [r("a", "critical")])).toEqual([r("a", "critical")]);
  });

  it("announces full severity-rises matrix without stale-announcement repeats", () => {
    const memory = new Map([
      ["fire1", "low"],
      ["fire2", "medium"],
      ["fire3", "high"],
      ["fire4", "critical"],
    ]);
    const current = [
      r("fire1", "medium"), // rise → announce
      r("fire2", "high"), // rise → announce
      r("fire3", "critical"), // rise → announce
      r("fire4", "critical"), // same → skip
      r("fire5", "low"), // first sighting → announce
    ];
    expect(computeNewAlerts(memory, current)).toEqual([
      r("fire1", "medium"),
      r("fire2", "high"),
      r("fire3", "critical"),
      r("fire5", "low"),
    ]);
  });

  it("never announces when nothing escalated", () => {
    const memory = new Map([
      ["a", "medium"],
      ["b", "critical"],
    ]);
    expect(computeNewAlerts(memory, [r("a", "medium"), r("b", "critical")])).toEqual([]);
  });
});
