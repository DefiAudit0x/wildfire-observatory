import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { randomBytes } from "node:crypto";
import config from "./config.js";
import logger from "./logger.js";
import { getDb } from "./firebase.js";
import { docGet, docSet } from "./fs.js";

export type UserRole = "admin" | "superadmin" | "commander" | "agent";
export type AdminSessionRole = "admin" | "superadmin";

export interface AuthPayload {
  role: UserRole;
  unitId?: string;
  name?: string;
  agentId?: string;
  /** S-M1: per-session revocation id — present on all admin sessions. */
  jti?: string;
  iat?: number;
}

export const ALL_ROLES: readonly UserRole[] = ["admin", "superadmin", "commander", "agent"];
export const OFFICER_ROLES: readonly UserRole[] = ["admin", "superadmin", "commander"];

// S-M1: admin sessions used to be bare { role } JWTs — no identity, no way to
// revoke anything but the cookie itself. A stolen admin cookie stayed valid for
// its full 24h regardless of logout, password rotation or incident response.
// Every token issued from now on carries a jti, and requireAuth checks it
// against the durable adminRevocations register (logout writes one entry per
// jti; the entry outlives the cookie and dies with the token's own exp).
// Legacy jti-less tokens keep working until natural 24h expiry — they simply
// stay un-revocable, which is exactly the old behaviour, never worse.
const ADMIN_REVOCATION_COLLECTION = "adminRevocations";

export function generateAdminToken(role: AdminSessionRole = "admin"): string {
  return jwt.sign({ role, jti: randomBytes(16).toString("hex") }, config.jwtSecret, { expiresIn: "24h" });
}

function isAdminSessionPayload(decoded: AuthPayload): boolean {
  return (
    (decoded.role === "admin" || decoded.role === "superadmin") &&
    !decoded.agentId &&
    !(decoded as { scope?: unknown }).scope
  );
}

/**
 * S-M1: revoke an admin session server-side. `token` is the raw admin_token
 * (cookie or bearer). Decoding (not verifying) is enough — a forged token
 * cannot produce a jti the register cares about, and an expired token's
 * revocation entry is inert. Returns true when a revocation was durably
 * written, false when there was nothing to revoke or the register is down.
 */
export async function revokeAdminSession(token: string | undefined | null, reason: string): Promise<boolean> {
  if (!token) return false;
  try {
    const decoded = jwt.decode(token) as (AuthPayload & { jti?: string; exp?: number }) | null;
    if (!decoded || typeof decoded.jti !== "string" || !decoded.jti) return false;
    const expMs = typeof decoded.exp === "number" ? decoded.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000;
    const ok = await docSet(ADMIN_REVOCATION_COLLECTION, decoded.jti, {
      revokedAt: new Date().toISOString(),
      exp: expMs,
      reason,
    });
    if (!ok) logger.warn({ jti: decoded.jti }, "Admin revocation register unavailable — token stays valid until expiry");
    return ok;
  } catch (err) {
    logger.warn({ err }, "Admin revocation write failed");
    return false;
  }
}

/**
 * S-M1: true when this jti sits in the revocation register. Expired register
 * entries are ignored (the token is dead anyway). A register outage is
 * fail-open ON PURPOSE: the admin password remains the real credential, and
 * locking the control room out during a Firestore outage would trade a
 * revocation edge case for an availability emergency.
 *
 * v2.15.0 audit hardening: the fail-open is no longer absolute. Successful
 * checks are cached in process memory, and a token ALREADY SEEN REVOKED stays
 * denied even when the register later goes down — an outage can no longer
 * resurrect a stolen, logged-out session. Tokens never seen revoked keep the
 * availability-first fail-open during an outage (the documented trade-off).
 */
const revocationSeen = new Map<string, number>(); // jti → expMs of a token seen revoked
async function isAdminSessionRevoked(jti: string): Promise<boolean> {
  try {
    const entry = await docGet(ADMIN_REVOCATION_COLLECTION, jti);
    if (!entry) return false;
    const exp = typeof entry.exp === "number" ? entry.exp : Date.parse(entry.exp);
    if (Number.isFinite(exp) && exp < Date.now()) return false;
    revocationSeen.set(jti, exp);
    return true;
  } catch (err) {
    // Register unreadable: a token previously seen revoked stays revoked
    // (its cached expiry governs); unknown tokens fail open as documented.
    const cachedExp = revocationSeen.get(jti);
    if (cachedExp !== undefined) {
      if (Number.isFinite(cachedExp) && cachedExp < Date.now()) return false;
      logger.warn({ jti }, "Admin revocation register down — using last-known revoked state");
      return true;
    }
    logger.warn({ err }, "Admin revocation check failed — failing open");
    return false;
  }
}

export function verifyAdminToken(token: string): { valid: boolean; role?: string } {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AuthPayload;
    return { valid: true, role: decoded.role };
  } catch {
    return { valid: false };
  }
}

export function generateStaffToken(payload: Omit<AuthPayload, "iat">): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "24h" });
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const cookieToken =
    (req as any).cookies?.admin_token ||
    (req as any).cookies?.staff_token;
  return authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : cookieToken || null;
}

export function isCurrentStaffSession(token: AuthPayload, user: any): boolean {
  if (!token.agentId || !user || user.isActive === false) return false;
  if (user.agentId !== token.agentId) return false;
  if (user.role !== token.role) return false;
  if ((user.unitId || undefined) !== (token.unitId || undefined)) return false;
  return true;
}

/** Any valid staff/admin session (role checked by callers when needed). */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized: missing or invalid token" });
    return;
  }
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AuthPayload;

    // C2 fix (extended by Team Mode): strict scope separation. Anonymous and
    // capability tokens — mesh relay, public principal, team-member GPS — are
    // issued for one narrow channel each. None of them is a session credential
    // and none may pass the staff/admin authentication gate.
    const scope = (decoded as { scope?: unknown }).scope;
    if (scope === "mesh") {
      res.status(403).json({ error: "Forbidden: mesh tokens are not session credentials" });
      return;
    }
    if (scope === "team-member" || scope === "public-principal") {
      res.status(403).json({ error: "Forbidden: this token scope is not a session credential" });
      return;
    }

    // S-M1: password-based admin sessions now carry a jti and are checked
    // against the durable revocation register — logout (or incident response)
    // kills a stolen cookie everywhere, without waiting for JWT expiry.
    // Staff sessions keep their own fail-closed revalidation below.
    if (isAdminSessionPayload(decoded) && typeof (decoded as { jti?: unknown }).jti === "string") {
      const db = getDb();
      if (db && (await isAdminSessionRevoked((decoded as { jti: string }).jti))) {
        res.status(401).json({ error: "Unauthorized: admin session has been revoked" });
        return;
      }
    }

    // Legacy password-based admin sessions have no agentId and therefore no
    // staff user record to revalidate. Staff sessions are fail-closed whenever
    // a Firestore database is configured: deactivation, role changes, unit
    // moves, and account deletion take effect without waiting for JWT expiry.
    if (decoded.agentId) {
      const db = getDb();
      if (db) {
        const user = await docGet("users", decoded.agentId);
        if (!isCurrentStaffSession(decoded, user)) {
          res.status(401).json({ error: "Unauthorized: staff session is no longer valid" });
          return;
        }
      }
    }

    (req as any).admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized: invalid or expired token" });
  }
}

/** Backward-compatible: same behaviour as before, but also accepts staff tokens who hold an officer role. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  void requireAuth(req, res, () => {
    const role = (req as any).admin?.role;
    if (role === "admin" || role === "superadmin") {
      next();
      return;
    }
    res.status(403).json({ error: "Forbidden: insufficient role" });
  });
}

/** Requires the caller to hold one of the given roles. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void requireAuth(req, res, () => {
      const role = (req as any).admin?.role as UserRole | undefined;
      if (role && roles.includes(role)) {
        next();
        return;
      }
      res.status(403).json({ error: "Forbidden: insufficient role" });
    });
  };
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, "Unhandled error");
  const isMulterSize = (err as any).code === "LIMIT_FILE_SIZE";
  const statusCode = (err as any).statusCode || (isMulterSize ? 400 : 500);
  const message = isMulterSize ? "Image too large (max 500KB)" : config.nodeEnv === "production" ? "Internal server error" : err.message;
  res.status(statusCode).json({ error: message });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}
