import { describe, expect, it } from "vitest";
import { normalizeSubmissionResult } from "../src/components/ReportForm";

describe("ReportForm submission result contract", () => {
  it("rejects an undefined server result", () => {
    expect(normalizeSubmissionResult(undefined)).toEqual({
      responseValid: false,
      error: "The server returned an invalid response.",
    });
  });

  it("accepts a server response only with responseValid, id, and status", () => {
    const result = normalizeSubmissionResult({
      responseValid: true,
      id: "rep-1",
      status: "verified",
      aiVerification: {
        confidence: 150,
        aiComments: "x".repeat(2000),
        detectedSigns: ["smoke", 42, "flame"],
        isVerified: true,
      },
    });
    expect(result.responseValid).toBe(true);
    expect(result.status).toBe("verified");
    expect(result.aiVerification?.confidence).toBe(100);
    expect(result.aiVerification?.aiComments).toHaveLength(1000);
    expect(result.aiVerification?.detectedSigns).toEqual(["smoke", "flame"]);
  });

  it("accepts an offline draft only with the explicit local marker", () => {
    expect(normalizeSubmissionResult({ responseValid: true, isOfflineDraft: true })).toMatchObject({
      responseValid: true,
      isOfflineDraft: true,
    });
  });

  it("rejects id-only, status-only, and unmarked offline shapes", () => {
    expect(normalizeSubmissionResult({ id: "rep-1" }).responseValid).toBe(false);
    expect(normalizeSubmissionResult({ status: "pending" }).responseValid).toBe(false);
    expect(normalizeSubmissionResult({ isOfflineDraft: true }).responseValid).toBe(false);
    expect(normalizeSubmissionResult({ responseValid: true, id: "rep-1" }).responseValid).toBe(false);
  });

  it("rejects malformed objects without an accepted report identity", () => {
    expect(normalizeSubmissionResult({ aiVerification: { confidence: 80 } }).responseValid).toBe(false);
  });
});
