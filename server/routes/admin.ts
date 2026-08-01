import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "crypto";
import { citizenReports } from "../data.js";
import { requireAdmin, generateAdminToken } from "../middleware.js";
import { updateReportInFirestore, deleteReportFromFirestore } from "../db.js";
import logger from "../logger.js";

const router = Router();

function safePasswordMatch(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

async function verifyAdminPassword(candidate: string): Promise<boolean> {
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  if (passwordHash && passwordHash.startsWith("$2")) {
    try {
      if (await bcrypt.compare(candidate, passwordHash)) return true;
    } catch (err) {
      logger.error({ err }, "bcrypt comparison error");
    }
  }
  const legacyPassword = process.env.ADMIN_PASSWORD;
  if (!legacyPassword) return false;
  return safePasswordMatch(candidate, legacyPassword);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
});

const updateStatusSchema = z
  .object({
    status: z.enum(["pending", "verified", "rejected", "resolved"]).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  })
  .refine((data) => data.status || data.severity, {
    message: "At least one of status or severity must be provided",
  });

router.post("/verify", loginLimiter, async (req: Request, res: Response) => {
  const { password } = req.body;
  if (!password) {
    res.status(400).json({ success: false, error: "Password required" });
    return;
  }
  if (await verifyAdminPassword(password)) {
    const token = generateAdminToken();
    res.json({ success: true, token });
  } else {
    logger.warn("Failed admin login attempt");
    res.status(401).json({ success: false, error: "Incorrect admin password" });
  }
});

const adminActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin actions. Slow down." },
});

router.post("/reports/:id/update-status", requireAdmin, adminActionLimiter, async (req: Request, res: Response) => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const { status, severity } = parsed.data;
  const { id } = req.params;

  const updateData: Record<string, any> = {};
  if (status) updateData.status = status;
  if (severity) updateData.severity = severity;

  const updated = await updateReportInFirestore(id, updateData);
  if (updated) {
    res.json({ success: true });
    return;
  }

  const report = citizenReports.find((r: any) => r.id === id);
  if (report) {
    if (status) report.status = status;
    if (severity) report.severity = severity;
    res.json({ success: true });
    return;
  }
  res.status(404).json({ error: "Report not found" });
});

router.post("/reports/:id/delete", requireAdmin, adminActionLimiter, async (req: Request, res: Response) => {
  const { id } = req.params;

  const deleted = await deleteReportFromFirestore(id);
  if (deleted) {
    res.json({ success: true });
    return;
  }

  const index = citizenReports.findIndex((r: any) => r.id === id);
  if (index !== -1) {
    citizenReports.splice(index, 1);
    res.json({ success: true });
    return;
  }
  res.status(404).json({ error: "Report not found" });
});

export default router;
