import { Request, Response, Router } from "express";
import { z } from "zod";
import logger from "../logger.js";
import { requireAuth, requireRole } from "../middleware.js";
import { collectionGet, docGet, docSet, docUpdate, docDelete } from "../fs.js";

const router = Router();

const unitSchema = z.object({
  code: z.string().min(1).max(12).regex(/^[A-Za-z0-9_-]+$/),
  nameAr: z.string().min(2).max(200),
  nameFr: z.string().min(2).max(200),
  wilaya: z.string().min(1).max(100),
});

export function toUnitId(code: string): string {
  return `unit-${code.toLowerCase()}`;
}

router.get("/", requireAuth, async (_req: Request, res: Response) => {
  try {
    const units = (await collectionGet("units")) || [];
    res.json({ units });
  } catch (err) {
    logger.error({ err }, "Failed to list units");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", requireRole("superadmin", "admin"), async (req: Request, res: Response) => {
  const parsed = unitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const unitId = toUnitId(parsed.data.code);
  try {
    const existing = await docGet("units", unitId);
    if (existing) {
      res.status(409).json({ error: "Unit code already exists" });
      return;
    }
    const now = new Date().toISOString();
    const actor = (req as any).admin?.agentId || "admin";
    const unit = {
      id: unitId,
      code: parsed.data.code,
      nameAr: parsed.data.nameAr,
      nameFr: parsed.data.nameFr,
      wilaya: parsed.data.wilaya,
      createdAt: now,
      updatedAt: now,
    };
    const ok = await docSet("units", unitId, unit);
    if (!ok) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    logger.info({ unitId, code: unit.code, actor }, "Unit created");
    res.status(201).json(unit);
  } catch (err) {
    logger.error({ err }, "Failed to create unit");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", requireRole("superadmin", "admin"), async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = unitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  if (toUnitId(parsed.data.code) !== id) {
    res.status(409).json({ error: "Unit code cannot change (it fixes the document id)" });
    return;
  }
  try {
    const existing = await docGet("units", id);
    if (!existing) {
      res.status(404).json({ error: "Unit not found" });
      return;
    }
    const updated = {
      ...existing,
      code: parsed.data.code,
      nameAr: parsed.data.nameAr,
      nameFr: parsed.data.nameFr,
      wilaya: parsed.data.wilaya,
      updatedAt: new Date().toISOString(),
    };
    const ok = await docSet("units", id, updated);
    if (!ok) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    res.json(updated);
  } catch (err) {
    logger.error({ err }, "Failed to update unit");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", requireRole("superadmin", "admin"), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const existing = await docGet("units", id);
    if (!existing) {
      res.status(404).json({ error: "Unit not found" });
      return;
    }
    const linkedUsers = (await collectionGet("users"))?.filter((u: any) => u.unitId === id) || [];
    if (linkedUsers.length > 0) {
      res.status(409).json({ error: "Cannot delete a unit that still has staff accounts" });
      return;
    }
    const ok = await docDelete("units", id);
    if (!ok) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete unit");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;