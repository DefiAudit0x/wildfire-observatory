import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";
import { collectionGet, docSet } from "../fs.js";
import { requireAdmin } from "../middleware.js";
import logger from "../logger.js";

const router = Router();

const memoryAudit: any[] = [];

export async function logAdminAction(action: string, details: Record<string, unknown> = {}): Promise<void> {
  const entry = {
    id: `audit-${Date.now()}-${randomBytes(3).toString("hex")}`,
    action,
    details,
    timestamp: new Date().toISOString(),
  };
  memoryAudit.unshift(entry);
  if (memoryAudit.length > 200) memoryAudit.length = 200;
  try {
    await docSet("adminAuditLog", entry.id, entry);
  } catch (err) {
    logger.error({ err }, "Failed to persist audit entry");
  }
}

const auditLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many audit requests. Slow down." },
});

router.get("/", requireAdmin, auditLimiter, async (_req: Request, res: Response) => {
  let entries: any[] | null = null;
  try {
    entries = await collectionGet("adminAuditLog", "timestamp", 100);
  } catch (err) {
    logger.error({ err }, "Audit log read failed");
  }
  res.json(entries && entries.length > 0 ? entries : memoryAudit.slice(0, 100));
});

export default router;
