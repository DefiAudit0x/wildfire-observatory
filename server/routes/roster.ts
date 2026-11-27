import { Request, Response, Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import logger from "../logger.js";
import { requireAuth } from "../middleware.js";
import { str } from "../params.js";
import { docGet, docSet, docDelete, collectionGet } from "../fs.js";
import { appendRosterPostAtomic, getFreshDocResult } from "../atomic.js";
import { toUnitId } from "./units.js";

const router = Router();

const rosterWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many roster updates, please slow down" },
});

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
}).superRefine((day, ctx) => {
  const ids = new Set<string>();
  day.posts.forEach((post, index) => {
    if (!post.id) return;
    if (ids.has(post.id)) {
      ctx.addIssue({ code: "custom", path: ["posts", index, "id"], message: "Post IDs must be unique" });
    }
    ids.add(post.id);
  });
});

function resolveUnitForWrite(admin: any, queryUnit: any): { unitId: string | null; error?: string } {
  const role = admin?.role;
  if (role !== "superadmin" && role !== "admin" && role !== "commander") {
    return { unitId: null, error: "Forbidden: agents cannot modify rosters" };
  }
  if (role === "commander") {
    if (!admin?.unitId) return { unitId: null, error: "Forbidden: missing unit on account" };
    return { unitId: toUnitId(admin.unitId) };
  }
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

function isArchivedDate(date: string): boolean {
  return date < todayISO();
}

const MAX_FUTURE_DAYS = 365;

// Fix 42 (RSTR-6): a shape regex is not a calendar check — "2026-11-31"
// and "2026-99-99" passed both isArchivedDate (lexical) and isTooFarFuture
// (NaN → false) and persisted under nonexistent days. Round-trip through a
// Date: setUTCFullYear normalizes overflow, so the check is the round trip
// itself (leap years and years 0–99 included).
function isValidCalendarDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
  );
}

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

async function canonicalizePersonnel(unitId: string, posts: any[]): Promise<{ posts: any[] } | { error: string; status: 403 | 503 }> {
  const canonicalPosts: any[] = [];
  const seenAgents = new Set<string>();
  // ARC-M08 fix: validation used to fire one SEQUENTIAL server round-trip per
  // personnel slot — up to 500 reads for a full 50-post day (and the operator
  // waited on every one of them). One cached collection read seeds a staff
  // map; only ids missing from the snapshot fall back to a fresh read.
  const staffCache = new Map<string, any>();
  const usersSnapshot = await collectionGet("users");
  if (Array.isArray(usersSnapshot)) {
    for (const user of usersSnapshot) {
      if (user?.id) staffCache.set(user.id, user);
    }
  }
  const missingIds = new Set<string>();
  for (const post of posts) {
    for (const person of post.personnel || []) {
      if (!staffCache.has(person.agentId)) missingIds.add(person.agentId);
    }
  }
  // Fix 42 (RSTR-7): a failed fresh read used to be silently dropped — the
  // agent stayed out of the cache and the validation loop below then
  // reported 403 "not an active staff account" for a DB outage. A fresh-read
  // error is a 503 and it wins over every validation error below.
  let freshReadFailed = false;
  await Promise.all(
    [...missingIds].map(async (agentId) => {
      const result = await getFreshDocResult("users", agentId);
      if (result.status === "found") staffCache.set(agentId, result.doc);
      else if (result.status === "error") freshReadFailed = true;
    })
  );
  if (freshReadFailed) {
    return { error: "Database not available", status: 503 };
  }
  for (const post of posts) {
    const personnel: any[] = [];
    for (const person of post.personnel || []) {
      if (seenAgents.has(person.agentId)) return { error: `Agent "${person.agentId}" is assigned twice on the same day`, status: 403 };
      const staff = staffCache.get(person.agentId);
      if (!staff || staff.role !== "agent" || staff.isActive === false) {
        return { error: `Agent "${person.agentId}" is not an active staff account`, status: 403 };
      }
      if (toUnitId(staff.unitId) !== unitId) {
        return { error: `Agent "${person.agentId}" does not belong to this unit`, status: 403 };
      }
      seenAgents.add(person.agentId);
      personnel.push({ ...person, name: staff.name });
    }
    canonicalPosts.push({ ...post, personnel });
  }
  return { posts: canonicalPosts };
}

router.get("/:date", requireAuth, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  // Fix 42 (RSTR-6): the shape above admits "2026-11-31" — reject dates
  // that are not real calendar days before any read.
  if (!isValidCalendarDate(date)) {
    res.status(400).json({ error: "Invalid date (not a real calendar date)" });
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
    // Fix 15 (RSTR-5): docGet returns null both for a genuinely missing day
    // and for a read failure, so the old code answered an outage with a
    // successful empty unsaved roster — an operator saving that display
    // after recovery would replace the real day. getFreshDocResult
    // distinguishes the two: a failed read is a 503, never an empty roster.
    const result = await getFreshDocResult(rosterPath(unitId), date);
    if (result.status === "error") {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const day = result.status === "found" ? result.doc : null;
    res.json({ unitId, date, posts: day?.posts || [], saved: Boolean(day) });
  } catch (err) {
    logger.error({ err }, "Failed to read roster");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:date", requireAuth, rosterWriteLimiter, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  // Fix 42 (RSTR-6): the shape above admits "2026-11-31" — reject dates
  // that are not real calendar days before any write.
  if (!isValidCalendarDate(date)) {
    res.status(400).json({ error: "Invalid date (not a real calendar date)" });
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
  const canonical = await canonicalizePersonnel(unitId, parsed.data.posts);
  if ("error" in canonical) {
    // Fix 42 (RSTR-7): a fresh-read failure during canonicalization is a
    // 503, not a 403 — canonical.status carries the distinction.
    res.status(canonical.status).json({ error: canonical.error });
    return;
  }
  const posts = ensurePostIds(canonical.posts);
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
      modified: posts.filter((p) => existingIds.has(p.id) && JSON.stringify(existingPosts.find((e: any) => e.id === p.id)) !== JSON.stringify(p)).length,
    };
    logger.info({ unitId, date, actor: admin?.agentId || "admin", diff }, "Roster saved");
    res.json(day);
  } catch (err) {
    logger.error({ err }, "Failed to save roster");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:date", requireAuth, rosterWriteLimiter, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  // Fix 42 (RSTR-6): the shape above admits "2026-11-31" — reject dates
  // that are not real calendar days before any write.
  if (!isValidCalendarDate(date)) {
    res.status(400).json({ error: "Invalid date (not a real calendar date)" });
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
  const canonical = await canonicalizePersonnel(unitId, [parsed.data]);
  if ("error" in canonical) {
    // Fix 42 (RSTR-7): a fresh-read failure during canonicalization is a
    // 503, not a 403 — canonical.status carries the distinction.
    res.status(canonical.status).json({ error: canonical.error });
    return;
  }
  const newPost = ensurePostIds(canonical.posts)[0];
  try {
    const result = await appendRosterPostAtomic(rosterPath(unitId), date, unitId, newPost, MAX_POSTS_PER_DAY);
    if (result === "limit") {
      res.status(409).json({ error: `Maximum ${MAX_POSTS_PER_DAY} posts per day` });
      return;
    }
    if (result === "duplicate-agent") {
      res.status(409).json({ error: "One or more agents are already assigned on this day" });
      return;
    }
    if (result === "duplicate-post-id") {
      res.status(409).json({ error: "Post ID already exists on this day" });
      return;
    }
    if (result !== "created") {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    res.status(201).json(newPost);
  } catch (err) {
    logger.error({ err }, "Failed to add roster post");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:date", requireAuth, rosterWriteLimiter, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  // Fix 42 (RSTR-6): the shape above admits "2026-11-31" — reject dates
  // that are not real calendar days before any write.
  if (!isValidCalendarDate(date)) {
    res.status(400).json({ error: "Invalid date (not a real calendar date)" });
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

router.post("/:date/copy-to/:target", requireAuth, rosterWriteLimiter, async (req: Request, res: Response) => {
  const date = str(req.params.date);
  const target = str(req.params.target);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    return;
  }
  // Fix 42 (RSTR-6): the shape above admits "2026-11-31" — reject dates
  // that are not real calendar days, on both the source and the target,
  // before any read or write.
  if (!isValidCalendarDate(date) || !isValidCalendarDate(target)) {
    res.status(400).json({ error: "Invalid date (not a real calendar date)" });
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
    const canonical = await canonicalizePersonnel(unitId, source.posts.map((p: any) => ({ ...p })));
    if ("error" in canonical) {
      // Fix 42 (RSTR-7): a fresh-read failure during canonicalization is a
      // 503, not a 403 — canonical.status carries the distinction.
      res.status(canonical.status).json({ error: canonical.error });
      return;
    }
    const posts = ensurePostIds(canonical.posts);
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
