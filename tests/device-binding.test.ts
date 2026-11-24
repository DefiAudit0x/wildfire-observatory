import { describe, expect, it } from "vitest";
import { boundDeviceId, issueDeviceCookie, ownsDevice } from "../server/deviceBinding.js";

function issue(id: string): string {
  let captured = "";
  const res = {
    cookie: (_name: string, value: string, _opts: unknown) => {
      captured = value;
    },
  } as any;
  issueDeviceCookie(res, id);
  return captured;
}

function reqWith(cookie: string): any {
  return { cookies: { device_sig: cookie } };
}

describe("device binding — dotted device ids (Fix 44, DVC-1)", () => {
  it("round-trips a dotted device id through issue and verify", () => {
    const cookie = issue("device.with.dot");
    expect(cookie.length).toBeGreaterThan(0);
    // Fail-without-fix: the old first-dot split read id "device" and a
    // signature of "with.dot.<sig>", so the length check failed and verify
    // returned null for every later access.
    expect(boundDeviceId(reqWith(cookie))).toBe("device.with.dot");
    expect(ownsDevice(reqWith(cookie), "device.with.dot")).toBe(true);
  });

  it("controls: plain ids round-trip, tampered signatures and malformed cookies return null", () => {
    const plain = issue("web_abc123");
    expect(boundDeviceId(reqWith(plain))).toBe("web_abc123");
    expect(ownsDevice(reqWith(plain), "web_abc123")).toBe(true);

    const tampered = plain.slice(0, -1) + (plain.endsWith("A") ? "B" : "A");
    expect(boundDeviceId(reqWith(tampered))).toBeNull();

    expect(boundDeviceId(reqWith("nodot"))).toBeNull();
    expect(boundDeviceId(reqWith(".onlysig"))).toBeNull();
    expect(boundDeviceId({ cookies: {} } as any)).toBeNull();
  });
});
