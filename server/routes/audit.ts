import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";
import { collectionGet, docSet } from "../fs.js";
import { requireAdmin } from "../middleware.js";
import logger from "../logger.js";

const router = Router();

const memoryAudit: any[] = [];

// S-M8: audit writes used to be fire-and-forget into a void — a Firestore
// outage (or no-db mode) silently dropped EVERY privileged action, while the
// HTTP caller still got 200. There is now a bounded durable-pending queue:
// a failed entry survives in memory (newest kept, like the Android offline
// queue), is retried on the next audit write and by a 60s sweeper, so a
// transient outage delays the trail instead of erasing it.
const pendingAudit: any[] = [];
const PENDING_AUDIT_MAX = 500;

async function persistAuditEntry(entry: any): Promise<boolean> {
  try {
    const ok = await docSet("adminAuditLog", entry.id, entry);
    // docSet resolves FALSE on no-db mode — that is exactly the outage case
    // the queue exists for, not a success.
    if (ok === false) {
      logger.error({ auditId: entry.id }, "Audit entry not persisted — database unavailable");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, auditId: entry.id }, "Failed to persist audit entry");
    return false;
  }
}

/** Retry everything queued by earlier failures; stops at the first failure. */
export async function flushPendingAudit(): Promise<number> {
  let flushed = 0;
  while (pendingAudit.length > 0) {
    if (!(await persistAuditEntry(pendingAudit[0]))) break;
    pendingAudit.shift();
    flushed++;
  }
  return flushed;
}

const pendingAuditSweeper = setInterval(() => { void flushPendingAudit(); }, 60 * 1000);
pendingAuditSweeper.unref();

// L5 fix: identity of who performed an administrative action, captured from
// the authenticated request. Without it, an audit trail shared by several
// supervisors is meaningless for attribution or incident response.
export interface AdminActionActor {
  agentId?: string | null;
  name?: string | null;
  ip?: string | null;
}

export function actorFromRequest(req: Request): AdminActionActor {
  const admin = (req as any).admin;
  return {
    agentId: admin?.agentId ?? null,
    name: admin?.name ?? null,
    ip: req.ip || null,
  };
}

export async function logAdminAction(
  action: string,
  details: Record<string, unknown> = {},
  actor?: AdminActionActor
): Promise<void> {
  const entry = {
    id: `audit-${Date.now()}-${randomBytes(3).toString("hex")}`,
    action,
    details,
    actorId: actor?.agentId || null,
    actorName: actor?.name || null,
    ip: actor?.ip || null,
    timestamp: new Date().toISOString(),
  };
  memoryAudit.unshift(entry);
  if (memoryAudit.length > 200) memoryAudit.length = 200;
  // Drain older failures first so ordering roughly follows event order.
  await flushPendingAudit();
  if (!(await persistAuditEntry(entry))) {
    if (pendingAudit.length >= PENDING_AUDIT_MAX) pendingAudit.shift();
    pendingAudit.push(entry);
    logger.warn({ auditId: entry.id, queued: pendingAudit.length }, "Audit entry queued after persistence failure");
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
