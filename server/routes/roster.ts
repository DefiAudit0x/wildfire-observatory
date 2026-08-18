import { Request, Response, Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import logger from "../logger.js";
import { requireAuth } from "../middleware.js";
import { str } from "../params.js";
import { docGet, docSet, docDelete } from "../fs.js";
import { toUnitId } from "./units.js";

const router = Router();

const rosterWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many roster updates, please slow down" },
});

/**
 * Daily duty roster (جدول المناوبة).
 *
 * Storage: units/{unitId}/rosterDays/{YYYY-MM-DD}
 *   doc = { unitId, date, posts: [ Post ] }
 *   Post = { id, labelAr, labelFr?, vehicle?, status: active|standby|maintenance, personnel: [ {agentId, name, rank?} ] }
 *
 * A "post" (منصب) may hold MULTIPLE staff at the same time (personnel array).
 */

export const MAX_PERSONNEL_PER_POST = 10;
export const MAX_POSTS_PER_DAY = 50;

const personnelSchema = z.object({
  agentId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  rank: z.string().min(1).max(60).optional(),
});

const postSchema = z.object({
  id: z.string().min(1).max(40).optional(),
  labelAr: z.string().min(1).max(160),
  labelEn: z.string().min(1).max(160).optional(),
  vehicle: z.string().min(1).max(160).optional(),
  status: z.enum(["active", "standby", "maintenance"]).default("active"),
  personnel: z.array(personnelSchema).max(MAX_PERSONNEL_PER_POST).default([]),
});

const daySchema = z.object({
  posts: z.array(postSchema).max(MAX_POSTS_PER_DAY),
});

// Resolve which unit the caller acts on.
// - superadmin/admin: may pass ?unit=<code>, otherwise use their own unitId
// - commander: always their own unit; can write.
// - agent: read-only.
function resolveUnitForWrite(admin: any, queryUnit: any): { unitId: string | null; error?: string } {
  const role = admin?.role;
  if (role !== "superadmin" && role !== "admin" && role !== "commander") {
    return { unitId: null, error: "Forbidden: agents cannot modify rosters" };
  }
  if (role === "commander") {
    if (!admin?.unitId) return { unitId: null, error: "Forbidden: missing unit on account" };
    return { unitId: toUnitId(admin.unitId) };
  }
  // superadmin/admin may override unit via ?unit=code
  if (typeof queryUnit === "string" && queryUnit.trim()) {
    return { unitId: toUnitId(queryUnit.trim()) };
  }
  if (admin?.unitId) return { unitId: toUnitId(admin.unitId) };
  return { unitId: null, error: "A unit is required (?unit=DZ16 or put a unit on the account)" };
}

function rosterPath(unitId: string): string {
  return `units/${unitId}/rosterDays`;
}

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Archived days (strictly before today) are read-only. */
function isArchivedDate(date: string): boolean {
  return date < todayISO();
}

const MAX_FUTURE_DAYS = 365;

/** Roster planning beyond a year ahead is rejected. */
function isTooFarFuture(date: string): boolean {
  const target = new Date(`${date}T12:00:00Z`).getTime();
  return target - Date.now() > MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000;
}

function ensurePostIds(posts: any[]): any[] {
  return posts.map((p) => ({
    ...p,
    id: p.id || `post-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  }));
}

// GET /api/roster/:date — read the roster for the caller's unit
router.get("/:date", requireAuth, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  const admin = (req as any).admin;
  const role = admin?.role;
  let unitId: string;
  if (role === "superadmin" || role === "admin") {
    if (typeof req.query.unit === "string" && req.query.unit.trim()) {
      unitId = toUnitId(req.query.unit.trim());
    } else if (admin?.unitId) {
      unitId = toUnitId(admin.unitId);
    } else {
      res.status(400).json({ error: "A unit is required (?unit=DZ16)" });
      return;
    }
  } else {
    if (!admin?.unitId) {
      res.status(400).json({ error: "No unit on account" });
      return;
    }
    unitId = toUnitId(admin.unitId);
  }
  try {
    const day = await docGet(rosterPath(unitId), date);
    res.json({ unitId, date, posts: day?.posts || [], saved: Boolean(day) });
  } catch (err) {
    logger.error({ err }, "Failed to read roster");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/roster/:date — replace the whole day roster (commander/superadmin)
router.put("/:date", requireAuth, rosterWriteLimiter, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  const admin = (req as any).admin;
  const { unitId, error: scopeError } = resolveUnitForWrite(admin, req.query.unit);
  if (!unitId) {
    res.status(403).json({ error: scopeError || "Forbidden" });
    return;
  }
  if (isArchivedDate(date)) {
    res.status(409).json({ error: "Past dates are archived (read-only). Move the roster to today instead." });
    return;
  }
  if (isTooFarFuture(date)) {
    res.status(400).json({ error: `Cannot plan rosters more than ${MAX_FUTURE_DAYS} days in the future` });
    return;
  }

  const parsed = daySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  // Guard: an agent may not appear on two posts the same day.
  const seenAgents = new Set<string>();
  for (const post of parsed.data.posts) {
    for (const p of post.personnel) {
      if (seenAgents.has(p.agentId)) {
        res.status(409).json({ error: `Agent "${p.agentId}" is assigned twice on the same day` });
        return;
      }
      seenAgents.add(p.agentId);
    }
  }

  const posts = ensurePostIds(parsed.data.posts);
  const day = { unitId, date, posts, updatedAt: new Date().toISOString() };
  try {
    const existing = await docGet(rosterPath(unitId), date);
    const ok = await docSet(rosterPath(unitId), date, day);
    if (!ok) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const existingPosts: any[] = existing?.posts || [];
    const existingIds = new Set(existingPosts.map((p: any) => p.id));
    const newIds = new Set(posts.map((p) => p.id));
    const diff = {
      added: posts.filter((p) => !existingIds.has(p.id)).length,
      removed: existingPosts.filter((p: any) => !newIds.has(p.id)).length,
      modified: posts.filter(
        (p) => existingIds.has(p.id) && JSON.stringify(existingPosts.find((e: any) => e.id === p.id)) !== JSON.stringify(p)
      ).length,
    };
    logger.info({ unitId, date, actor: admin?.agentId || "admin", diff }, "Roster saved");
    res.json(day);
  } catch (err) {
    logger.error({ err }, "Failed to save roster");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/roster/:date — append one post to the day (same write rules)
router.post("/:date", requireAuth, rosterWriteLimiter, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  const admin = (req as any).admin;
  const { unitId, error: scopeError } = resolveUnitForWrite(admin, req.query.unit);
  if (!unitId) {
    res.status(403).json({ error: scopeError || "Forbidden" });
    return;
  }
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  if (isArchivedDate(date)) {
    res.status(409).json({ error: "Past dates are archived (read-only)." });
    return;
  }
  if (isTooFarFuture(date)) {
    res.status(400).json({ error: `Cannot plan rosters more than ${MAX_FUTURE_DAYS} days in the future` });
    return;
  }
  try {
    const existing = await docGet(rosterPath(unitId), date);
    const posts = existing?.posts || [];
    if (posts.length >= MAX_POSTS_PER_DAY) {
      res.status(409).json({ error: `Maximum ${MAX_POSTS_PER_DAY} posts per day` });
      return;
    }
    const newPost = ensurePostIds([parsed.data])[0];
    const day = {
      unitId,
      date,
      posts: [...posts, newPost],
      updatedAt: new Date().toISOString(),
    };
    const ok = await docSet(rosterPath(unitId), date, day);
    if (!ok) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    res.status(201).json(newPost);
  } catch (err) {
    logger.error({ err }, "Failed to add roster post");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/roster/:date — clear the day
router.delete("/:date", requireAuth, rosterWriteLimiter, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  const admin = (req as any).admin;
  const { unitId, error: scopeError } = resolveUnitForWrite(admin, req.query.unit);
  if (!unitId) {
    res.status(403).json({ error: scopeError || "Forbidden" });
    return;
  }
  if (isArchivedDate(date)) {
    res.status(409).json({ error: "Past dates are archived (read-only)." });
    return;
  }
  if (isTooFarFuture(date)) {
    res.status(400).json({ error: `Cannot plan rosters more than ${MAX_FUTURE_DAYS} days in the future` });
    return;
  }
  try {
    const existing = await docGet(rosterPath(unitId), date);
    if (!existing) {
      res.status(404).json({ error: "Roster not found for this date" });
      return;
    }
    const ok = await docDelete(rosterPath(unitId), date);
    if (!ok) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete roster");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/roster/:date/copy-to/:target — duplicate a day's posts into another date
router.post("/:date/copy-to/:target", requireAuth, rosterWriteLimiter, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  const target = str(req.params.target);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  const admin = (req as any).admin;
  const { unitId, error: scopeError } = resolveUnitForWrite(admin, req.query.unit);
  if (!unitId) {
    res.status(403).json({ error: scopeError || "Forbidden" });
    return;
  }
  if (isArchivedDate(target)) {
    res.status(409).json({ error: "Cannot copy into an archived (past) date." });
    return;
  }
  if (isTooFarFuture(target)) {
    res.status(400).json({ error: `Cannot copy into a date more than ${MAX_FUTURE_DAYS} days in the future` });
    return;
  }
  try {
    const source = await docGet(rosterPath(unitId), date);
    if (!source || !Array.isArray(source.posts) || source.posts.length === 0) {
      res.status(404).json({ error: `No roster found for ${date} to copy from` });
      return;
    }
    const posts = ensurePostIds(source.posts.map((p: any) => ({ ...p })));
    const day = { unitId, date: target, posts, updatedAt: new Date().toISOString() };
    const ok = await docSet(rosterPath(unitId), target, day);
    if (!ok) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    logger.info({ unitId, from: date, to: target, actor: admin?.agentId || "admin" }, "Roster copied");
    res.status(201).json(day);
  } catch (err) {
    logger.error({ err }, "Failed to copy roster");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;