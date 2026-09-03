import { Request, Response, Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import logger from "../logger.js";
import { requireRole } from "../middleware.js";
import { str } from "../params.js";
import { logAdminAction, actorFromRequest } from "./audit.js";
import { collectionGet, docGet, docUpdate, docDelete, docSet } from "../fs.js";
import { createUserIfUnitExists, createDocIfAbsent } from "../atomic.js";
import { toUnitId } from "./units.js";

const router = Router();
const ROLES = ["superadmin", "commander", "agent"] as const;
const passwordSchema = z.string().min(10, "Password must be at least 10 characters").max(128).regex(/[A-Za-z]/, "Password must contain at least one letter").regex(/[0-9]/, "Password must contain at least one number");
const createUserSchema = z.object({ agentId: z.string().min(2).max(64).regex(/^[A-Za-z0-9._-]+$/), name: z.string().min(2).max(120), role: z.enum(ROLES), unitId: z.string().min(1), password: passwordSchema });
const updateUserSchema = z.object({ name: z.string().min(2).max(120).optional(), role: z.enum(ROLES).optional(), unitId: z.string().min(1).optional(), isActive: z.boolean().optional(), password: passwordSchema.optional() }).refine((data) => Object.keys(data).length > 0, { message: "At least one field required" });
function sanitizeUser(u: any) { return { agentId: u.agentId, name: u.name, role: u.role, unitId: u.unitId, isActive: u.isActive !== false, createdAt: u.createdAt }; }
function callerUnit(admin: any): { unitId: string | null; isSuperadmin: boolean } { const isSuperadmin = admin?.role === "superadmin" || admin?.role === "admin"; return { unitId: isSuperadmin ? null : admin?.unitId || null, isSuperadmin }; }
function requireScopedCommander(res: Response, admin: any): string | null { const { unitId, isSuperadmin } = callerUnit(admin); if (!isSuperadmin && !unitId) { res.status(403).json({ error: "Commander account has no assigned unit" }); return null; } return unitId; }

// S-M2 (role-matrix unification): the password-admin ("admin") used to hit a
// CONTRADICTION — DELETE /users required ("superadmin","admin") so an admin
// could delete any staff account, while GET/POST/PUT required
// ("superadmin","commander") so the SAME admin could not even list the users
// it was allowed to delete. The frontend (StaffManager.isSuper, RosterBoard
// .isWritable) already treats "admin" as super-tier. The matrix is now
// uniform: {admin, superadmin} = global staff management, commander = own
// unit's agents only, agent = nothing.
const MANAGE_USERS_ROLES = ["superadmin", "admin", "commander"] as const;

router.get("/", requireRole(...MANAGE_USERS_ROLES), async (req: Request, res: Response) => {
  try { const admin = (req as any).admin; const { unitId, isSuperadmin } = callerUnit(admin); if (requireScopedCommander(res, admin) === null && !isSuperadmin) return; let users = (await collectionGet("users")) || []; if (!isSuperadmin && unitId) users = users.filter((u: any) => u.unitId === unitId); res.json({ users: users.map(sanitizeUser) }); }
  catch (err) { logger.error({ err }, "Failed to list users"); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", requireRole(...MANAGE_USERS_ROLES), async (req: Request, res: Response) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() }); return; }
  const admin = (req as any).admin;
  const { unitId: allowedUnit, isSuperadmin } = callerUnit(admin);
  if (requireScopedCommander(res, admin) === null && !isSuperadmin) return;
  if (!isSuperadmin) {
    if (parsed.data.role !== "agent") { res.status(403).json({ error: "Commanders can only create agent accounts" }); return; }
    if (parsed.data.unitId !== allowedUnit) { res.status(403).json({ error: "Commanders can only add staff to their own unit" }); return; }
  }
  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    const now = new Date().toISOString();
    const user = { agentId: parsed.data.agentId, name: parsed.data.name, role: parsed.data.role, unitId: parsed.data.unitId, passwordHash, isActive: true, createdAt: now, createdBy: admin?.agentId || "admin" };
    const result = await createUserIfUnitExists(user.agentId, toUnitId(user.unitId), user);
    if (result === "exists") { res.status(409).json({ error: "agentId already exists" }); return; }
    if (result === "unit-missing") { res.status(404).json({ error: "Unit not found" }); return; }
    if (result === "unavailable") { res.status(503).json({ error: "Database not available" }); return; }
    // S-M8: account creation is a privilege grant — audit it.
    logAdminAction("user.create", { targetAgentId: user.agentId, role: user.role, unitId: user.unitId }, actorFromRequest(req)).catch(() => {});
    res.status(201).json(sanitizeUser(user));
  } catch (err) { logger.error({ err }, "Failed to create user"); res.status(500).json({ error: "Internal server error" }); }
});

router.put("/:agentId", requireRole(...MANAGE_USERS_ROLES), async (req: Request, res: Response) => {
  const agentId = str(req.params.agentId); const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() }); return; }
  const admin = (req as any).admin; const { unitId: allowedUnit, isSuperadmin } = callerUnit(admin); if (requireScopedCommander(res, admin) === null && !isSuperadmin) return;
  try {
    const existing = await docGet("users", agentId); if (!existing) { res.status(404).json({ error: "User not found" }); return; }
    if (!isSuperadmin) { if (existing.unitId !== allowedUnit) { res.status(403).json({ error: "Commanders can only manage their own unit's staff" }); return; } if (parsed.data.role && parsed.data.role !== "agent") { res.status(403).json({ error: "Commanders cannot change roles outside of agent" }); return; } if (parsed.data.unitId && parsed.data.unitId !== allowedUnit) { res.status(403).json({ error: "Commanders cannot move staff between units" }); return; }
    }
    if (parsed.data.unitId) { const unit = await docGet("units", toUnitId(parsed.data.unitId)); if (!unit) { res.status(404).json({ error: "Unit not found" }); return; } }
    const update: Record<string, any> = {}; if (parsed.data.name) update.name = parsed.data.name; if (parsed.data.role) update.role = parsed.data.role; if (parsed.data.unitId) update.unitId = parsed.data.unitId; if (parsed.data.isActive !== undefined) update.isActive = parsed.data.isActive; if (parsed.data.password) update.passwordHash = await bcrypt.hash(parsed.data.password, 10); update.updatedAt = new Date().toISOString(); update.updatedBy = admin?.agentId || "admin";
    const ok = await docUpdate("users", agentId, update); if (!ok) { res.status(503).json({ error: "Database not available" }); return; }
    // S-M8: role/unit/deactivation/password changes are privilege shifts —
    // audit what changed (never the password itself).
    logAdminAction(
      "user.update",
      { targetAgentId: agentId, fields: Object.keys(update).filter((f) => f !== "passwordHash"), roleChange: update.role ? { from: existing.role, to: update.role } : undefined },
      actorFromRequest(req)
    ).catch(() => {});
    res.json(sanitizeUser({ ...existing, ...update }));
  } catch (err) { logger.error({ err }, "Failed to update user"); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:agentId", requireRole("superadmin", "admin"), async (req: Request, res: Response) => {
  const agentId = str(req.params.agentId); const admin = (req as any).admin; if (admin?.agentId === agentId) { res.status(400).json({ error: "Cannot delete your own account" }); return; }
  try {
    const existing = await docGet("users", agentId);
    if (!existing) { res.status(404).json({ error: "User not found" }); return; }
    const ok = await docDelete("users", agentId);
    if (!ok) { res.status(503).json({ error: "Database not available" }); return; }
    // S-M8: account deletion is the harshest privilege action — audit it
    // BEFORE the (best-effort) roster sweep so the entry survives sweep errors.
    logAdminAction("user.delete", { targetAgentId: agentId, role: existing.role, unitId: existing.unitId }, actorFromRequest(req)).catch(() => {});
    // ARC-M10 fix: deleting a staff account used to leave the agent embedded in
    // every planned daily roster (displayed as an active assignment until the
    // day passed). Roster writes always validate unit membership, so an agent
    // can only ever appear in their own unit's rosterDays — sweeping that unit
    // is a complete, bounded cleanup.
    if (existing.unitId) {
      try {
        const rosterCollection = `units/${toUnitId(existing.unitId)}/rosterDays`;
        const days = await collectionGet(rosterCollection);
        if (Array.isArray(days)) {
          const affected = days.filter((dayDoc: any) =>
            Array.isArray(dayDoc?.posts) &&
            dayDoc.posts.some((p: any) => Array.isArray(p?.personnel) && p.personnel.some((x: any) => x?.agentId === agentId))
          );
          await Promise.all(affected.map((dayDoc: any) => {
            const posts = dayDoc.posts.map((p: any) => ({
              ...p,
              personnel: Array.isArray(p.personnel) ? p.personnel.filter((x: any) => x?.agentId !== agentId) : p.personnel,
            }));
            return docSet(rosterCollection, dayDoc.id, { ...dayDoc, posts, updatedAt: new Date().toISOString() });
          }));
          if (affected.length > 0) logger.info({ agentId, unitId: existing.unitId, days: affected.length }, "Removed deleted agent from planned rosters");
        }
      } catch (sweepErr) {
        logger.warn({ err: sweepErr, agentId }, "Roster cleanup after user deletion failed — rosters keep the historical copy");
      }
    }
    res.json({ success: true });
  } catch (err) { logger.error({ err }, "Failed to delete user"); res.status(500).json({ error: "Internal server error" }); }
});

export default router;