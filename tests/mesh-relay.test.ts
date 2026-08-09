import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

// Node < 19 does not expose globalThis.crypto; give the test env WebCrypto.
if (!(globalThis as any).crypto?.subtle) {
  (globalThis as any).crypto = webcrypto;
}

const { solvePoW, verifyPoW } = await import("../src/utils/meshBridge.js");
const { buildRelayedPayload } = await import("../src/lib/meshRelay.js");

describe("mesh PoW (browser fallback) — 32-bit window semantics", () => {
  it("solvePoW(…, 8) verifies with the same difficulty", async () => {
    const nonce = await solvePoW("pow-test-prefix", 8);
    expect(await verifyPoW("pow-test-prefix", nonce, 8)).toBe(true);
  });

  it("a wrong nonce fails verification", async () => {
    const nonce = await solvePoW("pow-test-prefix-2", 8);
    expect(await verifyPoW("pow-test-prefix-2", nonce + 1, 8)).toBe(false);
  });

  it("a solution for difficulty 9 also satisfies difficulty 8 (monotonic)", async () => {
    const nonce = await solvePoW("pow-test-prefix-3", 9);
    expect(await verifyPoW("pow-test-prefix-3", nonce, 8)).toBe(true);
  });

  it("clamps difficulty into 1..31 (never a no-op)", async () => {
    const nonce = await solvePoW("pow-test-prefix-4", 0);
    expect(nonce).toBeGreaterThanOrEqual(0);
    expect(await verifyPoW("pow-test-prefix-4", nonce, 1)).toBe(true);
  });
});

describe("buildRelayedPayload — mesh report envelope → API payload", () => {
  const envelope = (over: Record<string, unknown> = {}) => ({
    payload: JSON.stringify({
      locationName: "غابة اختبار",
      wilaya: "الجزائر - الطارف",
      description: "حريق محدود في الأحراش قرب مسالك الغابة — اختبار ترحيل",
      severity: "medium",
      reporterType: "citizen",
    }),
    type: "report",
    lat: 36.55,
    lng: 8.05,
    ts: Date.now(),
    powNonce: 42,
    powPrefix: "1700000000000-dev",
    powDifficulty: 8,
    ...over,
  });

  it("maps a well-formed envelope to a valid report payload", () => {
    const report = buildRelayedPayload(envelope());
    expect(report).not.toBeNull();
    expect(report!.lat).toBe(36.55);
    expect(report!.lng).toBe(8.05);
    expect(report!.severity).toBe("medium");
    expect(report!.reporterType).toBe("citizen");
  });

  it("rejects a payload missing required description length (server schema mirror)", () => {
    const bad = envelope();
    bad.payload = JSON.stringify({ locationName: "غابة", wilaya: "مل", description: "قصير" });
    expect(buildRelayedPayload(bad)).toBeNull();
  });

  it("rejects non-finite coordinates", () => {
    expect(buildRelayedPayload(envelope({ lat: "abc" }))).toBeNull();
    expect(buildRelayedPayload(envelope({ lng: undefined }))).toBeNull();
  });

  it("rejects non-JSON payloads and non-string payloads", () => {
    const bad = envelope();
    bad.payload = "not json {";
    expect(buildRelayedPayload(bad)).toBeNull();
    expect(buildRelayedPayload(envelope({ payload: 123 }))).toBeNull();
  });

  it("clamps severity/reporterType to allowed enums", () => {
    const report = buildRelayedPayload(envelope({ payload: undefined }));
    // rebuild with junk values
    const e = envelope();
    e.payload = JSON.stringify({
      locationName: "غابة اختبار",
      wilaya: "الجزائر - الطارف",
      description: "حريق محدود في الأحراش قرب مسالك الغابة — اختبار ترحيل",
      severity: "catastrophic",
      reporterType: "admin",
    });
    const clamped = buildRelayedPayload(e);
    expect(clamped!.severity).toBe("medium");
    expect(clamped!.reporterType).toBe("citizen");
  });
});