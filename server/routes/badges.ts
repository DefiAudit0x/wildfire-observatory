import { Request, Response, Router } from "express";
import { z } from "zod";
import { collectionGet, docSet, docUpdate, docDelete } from "../fs.js";
import { verifyAdminPassword } from "./admin.js";

const router = Router();

const badgeSchema = z.object({
  password: z.string().min(1),
  code: z.string().min(1),
  ownerName: z.string().min(1),
  type: z.string().min(1),
  wilaya: z.string().min(1),
  phone: z.string().optional(),
});

const memoryBadges: any[] = [];

async function loadBadges(): Promise<any[]> {
  if (memoryBadges.length === 0) {
    const fromDb = await collectionGet("badgeCodes");
    if (fromDb && fromDb.length > 0) {
      memoryBadges.push(...fromDb);
    }
  }
  return memoryBadges;
}

router.get("/", async (_req: Request, res: Response) => {
  const codes = await loadBadges();
  res.json(codes);
});

router.post("/", async (req: Request, res: Response) => {
  const parsed = badgeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const { password, code, ownerName, type, wilaya, phone } = parsed.data;
  if (!(await verifyAdminPassword(password))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const existing = await loadBadges();
  if (existing.find((b: any) => b.code === code)) {
    res.status(409).json({ error: "Code already exists" });
    return;
  }
  const newBadge = {
    code, ownerName, type, wilaya,
    phone: phone || undefined,
    createdAt: new Date().toISOString(),
    isActive: true,
  };
  await docSet("badgeCodes", code, newBadge);
  memoryBadges.push(newBadge);
  res.json(newBadge);
});

router.delete("/:code", async (req: Request, res: Response) => {
  const { password } = req.body;
  const { code } = req.params;
  if (!password || !(await verifyAdminPassword(password))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  await docDelete("badgeCodes", code);
  const idx = memoryBadges.findIndex((b: any) => b.code === code);
  if (idx !== -1) memoryBadges.splice(idx, 1);
  res.json({ success: true });
});

router.post("/:code/toggle", async (req: Request, res: Response) => {
  const { password } = req.body;
  const { code } = req.params;
  if (!password || !(await verifyAdminPassword(password))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const existing = await collectionGet("badgeCodes");
  const current = existing?.find((b: any) => b.code === code);
  if (current) {
    await docUpdate("badgeCodes", code, { isActive: !current.isActive });
  }
  const badge = memoryBadges.find((b: any) => b.code === code);
  if (badge) badge.isActive = !badge.isActive;
  res.json({ success: true });
});

export default router;
