import { Request, Response } from "express";

import { getDb, isAdminDb } from "../firebase.js";

export function healthHandler(_req: Request, res: Response): void {
  const durableIdempotency = process.env.E2E_DURABLE_ASSERTION === "true"
    ? (isAdminDb(getDb()) ? "admin" : "unavailable")
    : undefined;
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memoryUsage: process.memoryUsage().rss,
    ...(durableIdempotency ? { durableIdempotency } : {}),
  });
}
