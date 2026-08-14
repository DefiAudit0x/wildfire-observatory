import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

// Node < 19 does not expose globalThis.crypto; give the test env WebCrypto.
if (!(globalThis as any).crypto?.subtle) {
  (globalThis as any).crypto = webcrypto;
}

const {
  solvePoW,
  verifyPoW,
  canonicalLatLng,
  buildSignedData,
  initMesh,
  getLocalPublicKeyBase64,
  encryptForPeer,
  decryptFromPeer,
  isEncryptedMessageShape,
} = await import("../src/utils/meshBridge.js");
const { buildRelayedPayload, isRelayEnvelopeAdmissible } = await import("../src/lib/meshRelay.js");

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0").toUpperCase())
    .join("");

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

  it("rejects out-of-band difficulty (never a silent clamp)", async () => {
    await expect(solvePoW("pow-test-prefix-4", 0)).resolves.toBe(-1);
    await expect(solvePoW("pow-test-prefix-4", 32)).resolves.toBe(-1);
    await expect(verifyPoW("pow-test-prefix-4", 123, 0)).resolves.toBe(false);
  });
});

describe("relay admission policy", () => {
  it("requires exact network difficulty and fresh timestamp", () => {
    const now = 1_700_000_000_000;
    const base = { type: "report", powPrefix: "prefix", powNonce: 1, powDifficulty: 8, ts: now };
    expect(isRelayEnvelopeAdmissible(base, now)).toBe(true);
    expect(isRelayEnvelopeAdmissible({ ...base, powDifficulty: 7 }, now)).toBe(false);
    expect(isRelayEnvelopeAdmissible({ ...base, ts: now - 10 * 60 * 1000 - 1 }, now)).toBe(false);
  });
});

describe("canonical signed metadata — cross-runtime byte contract (audit round 12)", () => {
  it("canonicalLatLng emits micro-degrees identical to Kotlin", () => {
    expect(canonicalLatLng(0)).toBe("0");
    expect(canonicalLatLng(36.75)).toBe("36750000");
    expect(canonicalLatLng(-1.2345678)).toBe("-1234568");
    // The KILLER vector: 0.1+0.2 in JS. String(0.30000000000000004) would
    // produce different digits than native Double.toString — micro-degree
    // rounding makes both sides emit "300000".
    expect(canonicalLatLng(0.1 + 0.2)).toBe("300000");
  });

  it("buildSignedData matches the pinned Kotlin byte vector", () => {
    const bytes = buildSignedData(
      new Uint8Array(0),
      new Uint8Array(0),
      "m",
      "t",
      0,
      "e",
      "k",
      123456789,
      42,
      0.1 + 0.2,
      -1.2345678
    );
    const expected = (
      "00000000" + // ciphertext (empty)
      "00000000" + // iv (empty)
      "000000016D" + // "m"
      "0000000174" + // "t"
      "0000000130" + // "0"
      "0000000165" + // "e"
      "000000016B" + // "k"
      "00000009313233343536373839" + // "123456789"
      "000000023432" + // "42"
      "00000006333030303030" + // "300000"
      "000000082D31323334353638" // "-1234568"
    );
    expect(bytesToHex(bytes)).toBe(expected);
    // Same expectation is pinned in MeshWireTest.canonicalSignedDataVectorsArePinnedForTheBrowserMirror
  });
});

describe("EncryptedMessage runtime contract", () => {
  it("rejects missing wire-required metadata", () => {
    const incomplete = {
      ciphertext: "YQ==",
      iv: "YQ==",
      signature: "YQ==",
      ephemeralId: "ephemeral",
      senderPublicKey: "public-key",
      signatureKey: "signature-key",
      timestamp: Date.now(),
      lat: 36.5,
      lng: 8.1,
      nonce: 1,
    };
    expect(isEncryptedMessageShape(incomplete)).toBe(false);
    expect(isEncryptedMessageShape({ ...incomplete, signatureKey: undefined, messageId: "message", type: "report", hopCount: 0 })).toBe(true);
  });
});

describe("recipient-side key rotation (audit round 12)", () => {
  it("decrypts a message encrypted BEFORE our ephemeral key rotated", async () => {
    // A encrypts for B(K1); B rotates to K2; B must still decrypt the old
    // message (retained retired keys) — the decrypt-or-deterministic-requeue
    // contract the audit demanded.
    await initMesh();
    const plaintext = "حريق في غابة الاختبار قبل التدوير";
    // Browser-fallback "peer" is our own current key (mirrors the native
    // bridge: encrypt to the advertised key of the peer we address).
    const myKey = getLocalPublicKeyBase64();
    expect(myKey.length).toBeGreaterThan(0);
    const encrypted = await encryptForPeer(myKey, plaintext, 36.55, 8.05);
    expect(encrypted).not.toBeNull();

    // Rotate: a second initMesh() retires the old key pair.
    await initMesh();

    // The message encrypted under the OLD generation must still decrypt:
    // decryptFromPeer tries the current key first, then each retired key.
    const decrypted = await decryptFromPeer(encrypted!);
    expect(decrypted).toBe(plaintext);
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

  it("rejects invalid severity/reporterType instead of clamping them silently", () => {
    const e = envelope();
    e.payload = JSON.stringify({
      locationName: "غابة اختبار",
      wilaya: "الجزائر - الطارف",
      description: "حريق محدود في الأحراش قرب مسالك الغابة — اختبار ترحيل",
      severity: "catastrophic",
      reporterType: "admin",
    });
    expect(buildRelayedPayload(e)).toBeNull();
  });

  it("rejects out-of-range coordinates before submitting to the API", () => {
    expect(buildRelayedPayload(envelope({ lat: 91 }))).toBeNull();
    expect(buildRelayedPayload(envelope({ lng: -181 }))).toBeNull();
  });
});
