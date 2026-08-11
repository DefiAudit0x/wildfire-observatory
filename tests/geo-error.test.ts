import { describe, it, expect } from "vitest";
import { geoErrorMessage } from "../src/hooks/useGeolocation.js";

describe("geoErrorMessage — actionable per-code GPS failures", () => {
  it("tells the user permission is blocked (code 1)", () => {
    expect(geoErrorMessage(1, true)).toContain("إذن الموقع");
    expect(geoErrorMessage(1, false)).toContain("Autorisation");
  });

  it("tells the user to move to open space (code 2)", () => {
    expect(geoErrorMessage(2, true)).toContain("مساحة مفتوحة");
    expect(geoErrorMessage(2, false)).toContain("à découvert");
  });

  it("tells the user the request timed out (code 3)", () => {
    expect(geoErrorMessage(3, true)).toContain("مهلة");
    expect(geoErrorMessage(3, false).toLowerCase()).toContain("délai");
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(geoErrorMessage(undefined, true)).toContain("GPS");
    expect(geoErrorMessage(0, false)).toContain("GPS");
  });

  it("is never empty in either language", () => {
    expect(geoErrorMessage(1, true).length).toBeGreaterThan(5);
    expect(geoErrorMessage(3, false).length).toBeGreaterThan(5);
  });
});
