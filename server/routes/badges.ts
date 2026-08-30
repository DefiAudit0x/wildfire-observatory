import { Request, Response, Router } from "express";
import { z } from "zod";
import { collectionGet, docUpdate, docDelete } from "../fs.js";
import { createDocIfAbsent } from "../atomic.js";
import { requireAdmin } from "../middleware.js";
import { str } from "../params.js";
import { logAdminAction, actorFromRequest } from "./audit.js";

const router = Router();
const badgeSchema = z.object({ code: z.string().min(1).max(64), ownerName: z.string().min(1).max(120), type: z.string().min(1).max(40), wilaya: z.string().min(1).max(200), phone: z.string().max(30).optional(), maxUses: z.number().int().positive().optional(), expiresAt: z.string().optional() });
const updateBadgeSchema = badgeSchema.partial();
const memoryBadges: any[] = [];
async function loadBadges(): Promise<any[]> {
  const fromDb = await collectionGet("badgeCodes");
  if (fromDb) { memoryBadges.length = 0; memoryBadges.push(...fromDb.map((b: any) => ({ code: b.id, ...b }))); }
  return memoryBadges;
}
router.get("/", requireAdmin, async (_req: Request, res: Response) => { const codes = await loadBadges(); res.json(codes); });
router.get("/analytics", requireAdmin, async (_req: Request, res: Response) => {
  const badges = await loadBadges(); const now = Date.now();
  const isExpiredBadge = (b: any) => { if (!b.expiresAt) return false; const exp = typeof b.expiresAt === "number" ? b.expiresAt : new Date(b.expiresAt).getTime(); return Number.isFinite(exp) && exp <= now; };
  const isCapReached = (b: any) => typeof b.maxUses === "number" && b.maxUses > 0 && Number(b.usedCount || 0) >= b.maxUses;
  const active = badges.filter((b: any) => b.isActive === true && !isExpiredBadge(b) && !isCapReached(b)); const inactive = badges.filter((b: any) => b.isActive !== true); const expired = badges.filter(isExpiredBadge); const capReached = badges.filter(isCapReached);
  const byType: Record<string, number> = {}; const byWilaya: Record<string, number> = {};
  for (const b of badges) { byType[b.type] = (byType[b.type] || 0) + 1; byWilaya[b.wilaya] = (byWilaya[b.wilaya] || 0) + 1; }
  const totalUsage = badges.reduce((sum: number, b: any) => sum + Number(b.usedCount || 0), 0);
  const topUsed = [...badges].sort((a: any, b: any) => Number(b.usedCount || 0) - Number(a.usedCount || 0)).slice(0, 10).map((b: any) => ({ code: b.code, ownerName: b.ownerName, usedCount: Number(b.usedCount || 0), maxUses: b.maxUses }));
  res.json({ total: badges.length, active: active.length, inactive: inactive.length, expired: expired.length, capReached: capReached.length, totalUsage, byType, byWilaya, topUsed });
});
router.post("/", requireAdmin, async (req: Request, res: Response) => {
  const parsed = badgeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Missing or invalid required fields", details: parsed.error.flatten() }); return; }
  const existing = await loadBadges(); if (existing.find((b: any) => b.code === parsed.data.code)) { res.status(409).json({ error: "Code already exists" }); return; }
  // ARC-C2 fix: the PUT route in this file already writes null for absent
  // optional fields; the POST route used to pass `undefined` straight through
  // to createDocIfAbsent, so the admin UI's default (empty-optional) create
  // always 503'd with a fake "Database not available". Unify on null like PUT.
  const newBadge = { code: parsed.data.code, ownerName: parsed.data.ownerName, type: parsed.data.type, wilaya: parsed.data.wilaya, phone: parsed.data.phone || null, maxUses: parsed.data.maxUses ?? null, expiresAt: parsed.data.expiresAt ?? null, usedCount: 0, createdAt: new Date().toISOString(), isActive: true };
  const result = await createDocIfAbsent("badgeCodes", parsed.data.code, newBadge);
  if (result === "exists") { res.status(409).json({ error: "Code already exists" }); return; }
  if (result === "unavailable") { res.status(503).json({ error: "Database not available" }); return; }
  memoryBadges.push(newBadge); logAdminAction("badge.create", { code: parsed.data.code }, actorFromRequest(req)).catch(() => {}); res.json(newBadge);
});
router.put("/:code", requireAdmin, async (req: Request, res: Response) => {
  const code = str(req.params.code); const parsed = updateBadgeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid fields", details: parsed.error.flatten() }); return; }
  const existing = await loadBadges(); const current = existing.find((b: any) => b.code === code); if (!current) { res.status(404).json({ error: "Badge not found" }); return; }
  const update: Record<string, any> = {}; if (parsed.data.ownerName !== undefined) update.ownerName = parsed.data.ownerName; if (parsed.data.type !== undefined) update.type = parsed.data.type; if (parsed.data.wilaya !== undefined) update.wilaya = parsed.data.wilaya; if (parsed.data.phone !== undefined) update.phone = parsed.data.phone || null; if (parsed.data.maxUses !== undefined) update.maxUses = parsed.data.maxUses; if (parsed.data.expiresAt !== undefined) update.expiresAt = parsed.data.expiresAt || null; update.updatedAt = new Date().toISOString();
  const ok = await docUpdate("badgeCodes", code, update); if (!ok) { res.status(503).json({ error: "Database not available" }); return; } Object.assign(current, update); logAdminAction("badge.update", { code, fields: Object.keys(update) }, actorFromRequest(req)).catch(() => {}); res.json(current);
});
router.delete("/:code", requireAdmin, async (req: Request, res: Response) => {
  const code = str(req.params.code); const ok = await docDelete("badgeCodes", code); if (!ok) { res.status(503).json({ error: "Database not available" }); return; } const idx = memoryBadges.findIndex((b: any) => b.code === code); if (idx !== -1) memoryBadges.splice(idx, 1); logAdminAction("badge.delete", { code }, actorFromRequest(req)).catch(() => {}); res.json({ success: true });
});
router.post("/:code/toggle", requireAdmin, async (req: Request, res: Response) => {
  const code = str(req.params.code); const existing = await loadBadges(); const badge = existing.find((b: any) => b.code === code); if (!badge) { res.status(404).json({ error: "Badge not found" }); return; }
  const nextActive = badge.isActive !== true; const ok = await docUpdate("badgeCodes", code, { isActive: nextActive }); if (!ok) { res.status(503).json({ error: "Database not available" }); return; } badge.isActive = nextActive; logAdminAction("badge.toggle", { code, isActive: nextActive }, actorFromRequest(req)).catch(() => {}); res.json({ success: true, isActive: nextActive });
});
export default router;
