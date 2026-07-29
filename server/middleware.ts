import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import config from "./config.js";
import logger from "./logger.js";

export interface AuthPayload {
  role: "admin" | "superadmin";
  iat?: number;
}

export function generateAdminToken(): string {
  return jwt.sign({ role: "admin" }, config.jwtSecret, { expiresIn: "24h" });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized: missing or invalid token" });
    return;
  }
  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, config.jwtSecret) as AuthPayload;
    (req as any).admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized: invalid or expired token" });
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, "Unhandled error");
  const statusCode = (err as any).statusCode || 500;
  const message = config.nodeEnv === "production" ? "Internal server error" : err.message;
  res.status(statusCode).json({ error: message });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}
