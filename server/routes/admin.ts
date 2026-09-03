import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireAdmin, generateAdminToken, revokeAdminSession } from "../middleware.js";
import { str } from "../params.js";
import {
  updateReportInFirestore,
  deleteReportFromFirestore,
  purgeReportWithIdempotency,
  getReportsFromFirestore,
  getReportPrivate,
} from "../db.js";
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
    // S-M3: the password gate issues the "admin" role; the central-command
    // gate (SUPER_ADMIN_PASSWORD) issues "superadmin" — the two privileged
    // sessions are now distinguishable in /api/admin/session and the audit log.
    const token = generateAdminToken("admin");
    res.cookie("admin_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: 24 * 60 * 60 * 1000,
    });
    logAdminAction("admin.login", { success: true, role: "admin" }, actorFromRequest(req)).catch(() => {});
    res.json({ success: true, role: "admin" });
  } else {
    logger.warn("Failed admin login attempt");
    logAdminAction("admin.login", { success: false }, actorFromRequest(req)).catch(() => {});
    res.status(401).json({ success: false, error: "Incorrect admin password" });
  }
});

router.get("/session", requireAdmin, (req: Request, res: Response) => {
  // S-M3: announce which privileged role this session holds so the UI and
  // incident response can tell an "admin" password session from a
  // "superadmin" central-command session.
  res.json({ authenticated: true, role: (req as any).admin?.role ?? "admin" });
});

router.post("/logout", async (req: Request, res: Response) => {
  // S-M1: logout now revokes server-side, not just the cookie — a copied
  // admin_token dies in the revocation register instead of living 24h more.
  await revokeAdminSession(
    (req as any).cookies?.admin_token || req.headers.authorization?.replace(/^Bearer /, ""),
    "logout"
  );
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
  if (updated === "updated") {
    // Firestore is the source of truth here. Load the persisted report before
    // building a notification that depends on deviceId/locationName.
    const persistedReports = await getReportsFromFirestore();
    const report = persistedReports?.find((r: any) => r.id === id) ?? null;
    // S-H1: the public doc no longer carries deviceId (it lives in the
    // reportPrivate shard) — recover the addressee from the shard so status
    // notifications keep reaching the reporter after the privacy split.
    let notificationDeviceId: string | undefined =
      report?.deviceId ?? (typeof updateData.deviceId === "string" ? updateData.deviceId : undefined);
    if (!notificationDeviceId) {
      const priv = await getReportPrivate(id);
      notificationDeviceId = typeof priv?.deviceId === "string" ? priv.deviceId : undefined;
    }
    await buildStatusNotification({ ...(report || updateData), deviceId: notificationDeviceId }, status);
    logAdminAction("report.update-status", { id, status, severity }, actorFromRequest(req)).catch(() => {});
    liveHub.broadcast("report:update", { id, status, severity });
    res.json({ success: true });
    return;
  }

  // ARC-M05 fix: only the genuinely-missing / no-db cases land here, and both
  // mean the report does not exist — v2.3.0 removed the static demo seed the
  // old fallback used to mutate while claiming success. A real read/write
  // failure is a 503.
  if (updated === "missing" || updated === "no-db") {
    res.status(404).json({ error: "Report not found" });
    return;
  }

  res.status(503).json({ code: "DATABASE_UNAVAILABLE", error: "Report persistence is currently unavailable" });
});

router.post("/reports/:id/delete", requireAdmin, adminActionLimiter, async (req: Request, res: Response) => {
  const id = str(req.params.id);

  // ARC-H3 fix: purge the report together with its durable idempotency record —
  // leaving the key behind turned the citizen's offline draft into a permanent
  // 503 DURABLE_IDEMPOTENCY_UNAVAILABLE on every retry.
  const deleted = await purgeReportWithIdempotency(id);
  if (deleted === "deleted") {
    logAdminAction("report.delete", { id }, actorFromRequest(req)).catch(() => {});
    liveHub.broadcast("report:delete", { id });
    res.json({ success: true });
    return;
  }

  // v2.3.0 (simulation purge): the demo-seed splice is gone — without a
  // database there are no reports to delete. 404 honestly.
  if (deleted === "missing" || deleted === "no-db") {
    res.status(404).json({ error: "Report not found" });
    return;
  }

  res.status(503).json({ code: "DATABASE_UNAVAILABLE", error: "Report persistence is currently unavailable" });
});

export default router;
