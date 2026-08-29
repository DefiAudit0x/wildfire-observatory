import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import config from "./config.js";
import logger from "./logger.js";
import { getDb } from "./firebase.js";
import { docGet } from "./fs.js";

export type UserRole = "admin" | "superadmin" | "commander" | "agent";

export interface AuthPayload {
  role: UserRole;
  unitId?: string;
  name?: string;
  agentId?: string;
  iat?: number;
}

export const ALL_ROLES: readonly UserRole[] = ["admin", "superadmin", "commander", "agent"];
export const OFFICER_ROLES: readonly UserRole[] = ["admin", "superadmin", "commander"];

export function generateAdminToken(): string {
  return jwt.sign({ role: "admin" }, config.jwtSecret, { expiresIn: "24h" });
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

    // C2 fix: strict scope separation — a mesh token is issued anonymously to
    // any visitor for the /ws relay only. It is NOT a session credential and
    // must never pass the staff/admin authentication gate.
    if ((decoded as any).scope === "mesh") {
      res.status(403).json({ error: "Forbidden: mesh tokens are not session credentials" });
      return;
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
