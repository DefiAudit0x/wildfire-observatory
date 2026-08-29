import { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import config from "./config.js";

/**
 * M2 fix: device binding derived from a server secret, not from who asked
 * first. A plain cookie value proves nothing — anyone claiming a victim's
 * deviceId before them could bind it and read/modify their data, while the
 * real owner got 403. The cookie now carries an HMAC signature issued by
 * this server; possession of a validly-signed cookie for a device is the
 * only ownership proof, and it cannot be forged client-side.
 */
const DEVICE_SIG_COOKIE = "device_sig";
const DEVICE_SIG_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function signDevice(id: string): string {
  return createHmac("sha256", config.jwtSecret).update(id).digest("base64url");
}

/** Issue (or re-issue) the signed device-binding cookie for `id`. */
export function issueDeviceCookie(res: Response, id: string, maxAgeMs = DEVICE_SIG_MAX_AGE_MS): void {
  res.cookie(DEVICE_SIG_COOKIE, `${id}.${signDevice(id)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: maxAgeMs,
  });
}

/**
 * Returns the device id bound to this request's signed cookie, or null when
 * the cookie is absent or fails signature verification.
 */
export function boundDeviceId(req: Request): string | null {
  const bound = (req as any).cookies?.[DEVICE_SIG_COOKIE] as string | undefined;
  if (!bound) return null;
  const idx = bound.indexOf(".");
  if (idx <= 0) return null;
  const id = bound.slice(0, idx);
  const sig = bound.slice(idx + 1);
  const expected = signDevice(id);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return id;
}

/** True when this request carries a valid signed cookie for `claimed`. */
export function ownsDevice(req: Request, claimed: string): boolean {
  return boundDeviceId(req) === claimed;
}
