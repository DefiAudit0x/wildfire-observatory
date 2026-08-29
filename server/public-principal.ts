import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import config from "./config.js";

export const PUBLIC_PRINCIPAL_COOKIE = "public_principal";
const PUBLIC_PRINCIPAL_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface PublicPrincipalPayload {
  scope: "public-principal";
  subject: string;
  jti: string;
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
    sameSite: "lax",
    secure: config.nodeEnv === "production",
    maxAge: PUBLIC_PRINCIPAL_TTL_SECONDS * 1000,
    path: "/",
  });
  return { scope: "public-principal", subject, jti };
}
