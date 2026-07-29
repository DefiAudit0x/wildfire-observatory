import { Request, Response } from "express";

export function healthHandler(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memoryUsage: process.memoryUsage().rss,
  });
}
