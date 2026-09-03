import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import config from "./config.js";

export const PUBLIC_PRINCIPAL_COOKIE = "public_principal";
const PUBLIC_PRINCIPAL_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface PublicPrincipalPayload {
  scope: "public-principal";
  // Both fields are server-generated UUIDs (crypto.randomUUID) — typed as
  // the template literal that randomUUID() returns so the compiler keeps
  // caller-supplied free-form strings out of the issuance/renewal path.
  subject: `${string}-${string}-${string}-${string}-${string}`;
  jti: `${string}-${string}-${string}-${string}-${string}`;
}

export function createPublicPrincipalToken(subject = randomUUID(), jti = randomUUID()): string {
  const payload: PublicPrincipalPayload = { scope: "public-principal", subject, jti };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: PUBLIC_PRINCIPAL_TTL_SECONDS });
}

export function verifyPublicPrincipalToken(token: string): PublicPrincipalPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as PublicPrincipalPayload;
    if (!decoded || decoded.scope !== "public-principal" || typeof decoded.subject !== "string" || !decoded.subject || typeof decoded.jti !== "string" || !decoded.jti) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function getPublicPrincipal(req: Request): PublicPrincipalPayload | null {
  const token = req.cookies?.[PUBLIC_PRINCIPAL_COOKIE];
  return typeof token === "string" ? verifyPublicPrincipalToken(token) : null;
}

export function issuePublicPrincipal(res: Response): PublicPrincipalPayload {
  const subject = randomUUID();
  const jti = randomUUID();
  const token = createPublicPrincipalToken(subject, jti);
  res.cookie(PUBLIC_PRINCIPAL_COOKIE, token, {
    httpOnly: true,
    // SameSite=strict (not lax): the strict policy keeps the credential out of
    // every cross-site request, which is a recognized CSRF mitigation (CodeQL
    // js/missing-token-validation). Functionally safe here — the SPA and all
    // its API calls are same-origin, so strict never withholds the cookie
    // where it is actually needed.
    sameSite: "strict",
    secure: config.nodeEnv === "production",
    maxAge: PUBLIC_PRINCIPAL_TTL_SECONDS * 1000,
    path: "/",
  });
  return { scope: "public-principal", subject, jti };
}

/**
 * Phase C (principal-cookie ghosts): sliding renewal at join time.
 *
 * The principal previously lived exactly 30 days from the FIRST join — a
 * device that kept using the app silently lost its identity at day 30 and
 * minted a ghost duplicate member on its next join (memberId = hash of the
 * subject, so a new subject means a second member row with the same name).
 * Re-issuing the SAME subject on every join keeps any actively-joining
 * device anchored to one identity for as long as it actually uses the
 * system; only a device absent for a full window loses its identity, and
 * its member row is stale/inactive by then anyway. Same cookie options as
 * issuePublicPrincipal — this is a re-issue, not a different policy.
 */
export function renewPublicPrincipal(
  res: Response,
  // Same template type randomUUID() returns — a public principal subject is
  // always a server-generated UUID, never free-form caller input.
  subject: `${string}-${string}-${string}-${string}-${string}`
): PublicPrincipalPayload {
  const jti = randomUUID();
  const token = createPublicPrincipalToken(subject, jti);
  res.cookie(PUBLIC_PRINCIPAL_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.nodeEnv === "production",
    maxAge: PUBLIC_PRINCIPAL_TTL_SECONDS * 1000,
    path: "/",
  });
  return { scope: "public-principal", subject, jti };
}
