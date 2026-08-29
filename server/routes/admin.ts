import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { citizenReports } from "../data.js";
import { requireAdmin, generateAdminToken } from "../middleware.js";
import { str } from "../params.js";
import { updateReportInFirestore, deleteReportFromFirestore, getReportsFromFirestore } from "../db.js";
import { createNotification } from "./notifications.js";
import { logAdminAction, actorFromRequest } from "./audit.js";
import { liveHub } from "../live.js";
import logger from "../logger.js";
import config from "../config.js";

const router = Router();

let legacyAdminHashPromise: Promise<string> | null = null;
let legacySuperAdminHashPromise: Promise<string> | null = null;

async function configuredPasswordHash(
  configuredHash: string | undefined,
  legacyPassword: string | undefined,
  cache: "admin" | "superadmin"
): Promise<string> {
  if (configuredHash?.startsWith("$2")) return configuredHash;
  if (!legacyPassword) return "";

  if (cache === "admin") {
    legacyAdminHashPromise ??= bcrypt.hash(legacyPassword, 12);
    return legacyAdminHashPromise;
  }

  legacySuperAdminHashPromise ??= bcrypt.hash(legacyPassword, 12);
  return legacySuperAdminHashPromise;
}

export async function verifyAdminPassword(candidate: string): Promise<boolean> {
  const passwordHash = await configuredPasswordHash(
    process.env.ADMIN_PASSWORD_HASH,
    process.env.ADMIN_PASSWORD,
    "admin"
  );
  if (!passwordHash) return false;
  try {
    return await bcrypt.compare(candidate, passwordHash);
  } catch (err) {
    logger.error({ err }, "bcrypt comparison error");
    return false;
  }
}

export async function verifySuperAdminPassword(candidate: string): Promise<boolean> {
  const passwordHash = await configuredPasswordHash(
    process.env.SUPER_ADMIN_PASSWORD_HASH,
    process.env.SUPER_ADMIN_PASSWORD,
    "superadmin"
  );
  // M6 fix: fail closed — falling back to the admin password let one
  // ADMIN_PASSWORD unlock the super-admin role (user management, units,
  // central command) whenever SUPER_ADMIN_* was left unset.
  if (!passwordHash) return false;
  try {
    return await bcrypt.compare(candidate, passwordHash);
  } catch (err) {
    logger.error({ err }, "bcrypt super-admin comparison error");
    return false;
  }
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

const adminVerifySchema = z.object({ password: z.string().min(1).max(128) });

router.post("/verify", loginLimiter, async (req: Request, res: Response) => {
  const parsed = adminVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Password required" });
    return;
  }
  const { password } = parsed.data;
  if (await verifyAdminPassword(password)) {
    const token = generateAdminToken();
    res.cookie("admin_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: 24 * 60 * 60 * 1000,
    });
    logAdminAction("admin.login", { success: true }, actorFromRequest(req)).catch(() => {});
    res.json({ success: true });
  } else {
    logger.warn("Failed admin login attempt");
    logAdminAction("admin.login", { success: false }, actorFromRequest(req)).catch(() => {});
    res.status(401).json({ success: false, error: "Incorrect admin password" });
  }
});

router.get("/session", requireAdmin, (_req: Request, res: Response) => {
  res.json({ authenticated: true });
});

router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie("admin_token");
  res.json({ success: true });
});

const adminActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin actions. Slow down." },
});

async function buildStatusNotification(report: any, status?: string): Promise<void> {
  if (!report.deviceId) return;
  let msgAr = "";
  let msgFr = "";
  let type: "success" | "warning" | "info" = "info";
  if (status === "verified") { msgAr = "تم التحقق من تبليغك واعتماده."; msgFr = "Votre signalement a été vérifié et approuvé."; type = "success"; }
  else if (status === "rejected") { msgAr = "تم رفض تبليغك لعدم صحته."; msgFr = "Votre signalement a été rejeté car il n'est pas valide."; type = "warning"; }
  else if (status === "resolved") { msgAr = "تم التدخل بنجاح وإخماد الحريق."; msgFr = "Intervention réussie, l'incendie a été maîtrisé."; type = "success"; }
  else { msgAr = "تم تحديث حالة تبليغك."; msgFr = "Le statut de votre signalement a été mis à jour."; }
  try {
    await createNotification({
      deviceId: report.deviceId,
      titleAr: "تحديث بخصوص تبليغك",
      titleFr: "Mise à jour de votre signalement",
      bodyAr: `تبليغك عن (${report.locationName}): ${msgAr}`,
      bodyFr: `Votre signalement à (${report.locationName}): ${msgFr}`,
      type,
    });
  } catch (err) {
    logger.error({ err, deviceId: report.deviceId }, "Failed to persist status notification");
  }
}

router.post("/reports/:id/update-status", requireAdmin, adminActionLimiter, async (req: Request, res: Response) => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const { status, severity } = parsed.data;
  const id = str(req.params.id);

  const updateData: Record<string, any> = {};
  if (status) updateData.status = status;
  if (severity) updateData.severity = severity;

  const updated = await updateReportInFirestore(id, updateData);
  if (updated) {
    // Firestore is the source of truth here. The in-memory seed can be stale
    // or may not contain reports created after startup, so load the persisted
    // report before building a notification that depends on deviceId/locationName.
    const persistedReports = await getReportsFromFirestore();
    const report = persistedReports?.find((r: any) => r.id === id) ?? citizenReports.find((r: any) => r.id === id);
    await buildStatusNotification(report || updateData, status);
    logAdminAction("report.update-status", { id, status, severity }, actorFromRequest(req)).catch(() => {});
    liveHub.broadcast("report:update", { id, status, severity });
    res.json({ success: true });
    return;
  }

  const report = citizenReports.find((r: any) => r.id === id);
  if (report) {
    if (status) report.status = status;
    if (severity) report.severity = severity;
    await buildStatusNotification(report, status);
    logAdminAction("report.update-status", { id, status, severity }, actorFromRequest(req)).catch(() => {});
    liveHub.broadcast("report:update", { id, status, severity });
    res.json({ success: true });
    return;
  }
  res.status(404).json({ error: "Report not found" });
});

router.post("/reports/:id/delete", requireAdmin, adminActionLimiter, async (req: Request, res: Response) => {
  const id = str(req.params.id);

  const deleted = await deleteReportFromFirestore(id);
  if (deleted) {
    logAdminAction("report.delete", { id }, actorFromRequest(req)).catch(() => {});
    liveHub.broadcast("report:delete", { id });
    res.json({ success: true });
    return;
  }

  const index = citizenReports.findIndex((r: any) => r.id === id);
  if (index !== -1) {
    citizenReports.splice(index, 1);
    logAdminAction("report.delete", { id }, actorFromRequest(req)).catch(() => {});
    liveHub.broadcast("report:delete", { id });
    res.json({ success: true });
    return;
  }
  res.status(404).json({ error: "Report not found" });
});

export default router;
