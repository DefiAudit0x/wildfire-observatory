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

let pendingAuditFlush: Promise<number> | null = null;

/** Retry everything queued by earlier failures; concurrent callers join one drain. */
export function flushPendingAudit(): Promise<number> {
  if (pendingAuditFlush) return pendingAuditFlush;
  pendingAuditFlush = (async () => {
    let flushed = 0;
    while (pendingAudit.length > 0) {
      const entry = pendingAudit[0];
      if (!(await persistAuditEntry(entry))) break;
      // A concurrent failed log may have evicted this entry at the queue cap.
      if (pendingAudit[0] === entry) pendingAudit.shift();
      flushed++;
    }
    return flushed;
  })().finally(() => { pendingAuditFlush = null; });
  return pendingAuditFlush;
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
    if (pendingAudit.length >= PENDING_AUDIT_MAX) {
      const evicted = pendingAudit.shift();
      logger.error({ auditId: evicted?.id, pending: pendingAudit.length }, "Pending audit entry evicted; audit trail data lost");
    }
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
    entries = await collectionGet("adminAuditLog", "timestamp", 100, true, undefined, true);
  } catch (err) {
    logger.error({ err }, "Audit log read failed");
    res.status(503).json({ error: "Audit log temporarily unavailable" });
    return;
  }
  // Fix 41 (AUD-3): merge, don't pick a side — the DB list hides recent
  // entries that only exist in memoryAudit (a failed audit write queues
  // them locally). Both lists are newest-first; dedupe by id (an entry
  // that persisted sits in both), sort by timestamp desc, cap 100. The
  // response shape is unchanged. Read failures are reported above instead
  // of turning a partial process-local trail into a successful response.
  const dbEntries = entries ?? [];
  // Fix 41b (CodeRabbit Nitpick, review 6037710493): the merged list is
  // typed — no new `any` (the pre-existing `entries: any[] | null` and the
  // `memoryAudit: any[]` store are untouched). The entry shape mirrors
  // logAdminAction's entry below.
  type AuditEntry = { id: string; action: string; timestamp: string; [key: string]: unknown };
  const byId = new Map<string, AuditEntry>();
  for (const e of dbEntries) if (e?.id) byId.set(e.id, e);
  for (const e of memoryAudit) if (e?.id && !byId.has(e.id)) byId.set(e.id, e);
  const merged = [...byId.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 100);
  res.json(merged);
});

export default router;
