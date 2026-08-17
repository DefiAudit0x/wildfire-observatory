import { describe, expect, it } from "vitest";
import { normalizeSubmissionResult, toUserFacingSubmitError } from "../src/components/ReportForm";

describe("ReportForm submission result contract", () => {
  it("hides durable backend details behind an Arabic user-facing error", () => {
    const message = toUserFacingSubmitError("Admin Firestore durable idempotency is required for report submission", true);
    expect(message).toContain("خادم المرصد غير جاهز");
    expect(message).not.toContain("Admin Firestore");
  });

  it("keeps generic server errors visible when they are already user-facing", () => {
    expect(toUserFacingSubmitError("تعذر الاتصال بالخادم", true)).toBe("تعذر الاتصال بالخادم");
    expect(toUserFacingSubmitError(undefined, false)).toContain("Échec");
  });

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
