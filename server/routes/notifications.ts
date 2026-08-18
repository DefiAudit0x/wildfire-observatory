import { Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import logger from "../logger.js";
import config from "../config.js";
import { str } from "../params.js";
import { collectionGet, docSet, docUpdate } from "../fs.js";
import { sendVerificationEmail } from "../email.js";

const router = Router();
const unsubscribeSchema = z.object({ email: z.string().email().max(200), token: z.string().length(64) });

const memoryNotifications: any[] = [];

async function getNotificationsFromDb(deviceId: string): Promise<any[]> {
  const fromDb = await collectionGet("notifications", "timestamp", 100);
  if (fromDb !== null) {
    return fromDb.filter((n: any) => n.deviceId === deviceId);
  }
  return memoryNotifications.filter((n) => n.deviceId === deviceId);
}

async function deleteSubscriberByToken(email: string, token: string): Promise<boolean> {
  const { getDb, isAdminDb } = await import("../firebase.js");
  const db = getDb();
  if (!db) return false;
  if (isAdminDb(db)) {
    const existing = await db.collection("subscribers").where("email", "==", email).get();
    const match = existing.docs.find((doc: any) => doc.data().unsubscribeToken === token);
    if (!match) return false;
    await match.ref.delete();
    return true;
  }
  const { collection, getDocs, query, where, deleteDoc, doc } = await import("firebase/firestore");
  const snap = await getDocs(query(collection(db, "subscribers"), where("email", "==", email)));
  const match = snap.docs.find((entry) => entry.data().unsubscribeToken === token);
  if (!match) return false;
  await deleteDoc(doc(db, "subscribers", match.id));
  return true;
}

function isVerificationTokenValid(sub: any, token: string): boolean {
  const expiresAt = typeof sub.verificationExpiresAt === "string" ? Date.parse(sub.verificationExpiresAt) : NaN;
  return typeof sub.verificationToken === "string" &&
    sub.verificationToken === token &&
    Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function actionConfirmationHtml(action: "verify" | "unsubscribe", email: string, token: string): string {
  const title = action === "verify" ? "تأكيد الاشتراك" : "تأكيد إلغاء الاشتراك";
  const label = action === "verify" ? "تأكيد الاشتراك" : "إلغاء الاشتراك";
  const endpoint = action === "verify" ? "/api/notifications/verify" : "/api/notifications/unsubscribe";
  const escapedEmail = email.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const escapedToken = token.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<html dir="rtl"><meta charset="utf-8"><title>${title}</title><body><h2>${title}</h2><form method="post" action="${endpoint}"><input type="hidden" name="email" value="${escapedEmail}"><input type="hidden" name="token" value="${escapedToken}"><button type="submit">${label}</button></form></body></html>`;
}

const unsubscribeLinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/unsubscribe", unsubscribeLinkLimiter, async (req: Request, res: Response) => {
  const email = typeof req.query.email === "string" ? req.query.email : "";
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const parsed = unsubscribeSchema.safeParse({ email, token });
  if (!parsed.success) {
    res.status(400).send("Invalid unsubscribe link");
    return;
  }
  res.type("html").send(actionConfirmationHtml("unsubscribe", parsed.data.email, parsed.data.token));
});

export async function createNotification(notif: { deviceId: string; titleAr: string; titleFr: string; bodyAr: string; bodyFr: string; type: "success" | "warning" | "error" | "info" }) {
  const newNotif = {
    ...notif,
    id: `notif-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    timestamp: new Date().toISOString(),
    read: false,
  };
  try {
    const persisted = await docSet("notifications", newNotif.id, newNotif);
    if (!persisted) throw new Error("notification persistence unavailable");
  } catch (err) {
    logger.error({ err }, "Error saving notification");
    throw err;
  }
  memoryNotifications.unshift(newNotif);
  return newNotif;
}

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many verification requests. Try again shortly." },
});

router.get("/verify", verifyLimiter, async (req: Request, res: Response) => {
  const parsed = verificationSchema.safeParse({ email: req.query.email, token: req.query.token });
  if (!parsed.success) {
    res.status(400).json({ error: "Email and token are required" });
    return;
  }
  res.type("html").send(actionConfirmationHtml("verify", parsed.data.email, parsed.data.token));
});

router.post("/verify", verifyLimiter, async (req: Request, res: Response) => {
  const { email, token } = req.body;
  if (!email || !token) {
    res.status(400).json({ error: "Email and token are required" });
    return;
  }

  try {
    const { getDb, isAdminDb } = await import("../firebase.js");
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: "Database not available" });
      return;
    }

    if (isAdminDb(db)) {
      const existing = await db.collection("subscribers").where("email", "==", email).get();
      if (existing.empty) {
        res.status(404).json({ error: "Subscriber not found" });
        return;
      }
      const sub = existing.docs[0].data() as any;
      if (!isVerificationTokenValid(sub, token)) {
        res.status(403).json({ error: "Invalid verification token" });
        return;
      }
      await existing.docs[0].ref.update({ verified: true, verificationToken: null, verificationExpiresAt: null });
    } else {
      const { collection, getDocs, query, where, updateDoc, doc } = await import("firebase/firestore");
      const q = query(collection(db, "subscribers"), where("email", "==", email));
      const snap = await getDocs(q);
      if (snap.empty) {
        res.status(404).json({ error: "Subscriber not found" });
        return;
      }
      const sub = snap.docs[0].data() as any;
      if (!isVerificationTokenValid(sub, token)) {
        res.status(403).json({ error: "Invalid verification token" });
        return;
      }
      await updateDoc(doc(db, "subscribers", snap.docs[0].id), { verified: true, verificationToken: null, verificationExpiresAt: null });
    }
    res.send("<h2>✅ اشتراكك مؤكد! سنرسل لك تنبيهات الحرائق.</h2>");
  } catch (err) {
    logger.error({ err }, "Failed to verify");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:deviceId", async (req: Request, res: Response) => {
  const deviceId = str(req.params.deviceId);
  const cookieDevice = (req as any).cookies?.deviceId;
  // The deviceId cookie acts as the bearer proof of ownership. A request that
  // claims a DIFFERENT deviceId than the one this browser is bound to is an
  // IDOR probe — refuse instead of silently rebinding to the attacker's value.
  if (cookieDevice && cookieDevice !== deviceId) {
    res.status(403).json({ error: "Device identity mismatch. Clear site data (cookies) to bind a new device." });
    return;
  }
  if (!cookieDevice) {
    res.cookie("deviceId", deviceId, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  const notifs = await getNotificationsFromDb(deviceId);
  res.json(notifs);
});

router.post("/:id/read", async (req: Request, res: Response) => {
  const id = str(req.params.id);
  const cookieDevice = (req as any).cookies?.deviceId;
  if (!cookieDevice) {
    res.status(403).json({ error: "Forbidden: no device binding" });
    return;
  }
  const owned = (await getNotificationsFromDb(cookieDevice)).some((n: any) => n.id === id);
  if (!owned) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }
  try {
    const persisted = await docUpdate("notifications", id, { read: true });
    if (!persisted) {
      res.status(503).json({ error: "Notification persistence unavailable" });
      return;
    }
  } catch (err) {
    logger.error({ err, id }, "Error updating notification");
    res.status(503).json({ error: "Notification persistence unavailable" });
    return;
  }
  const notif = memoryNotifications.find((n: any) => n.id === id);
  if (notif) notif.read = true;
  res.json({ success: true });
});

const subscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many subscription requests. Try again shortly." },
});

const subscribeSchema = z.object({
  email: z.string().email(),
  wilayas: z.array(z.string()).optional(),
  minSeverity: z.enum(["low", "medium", "high", "critical"]).optional(),
});

function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

router.post("/subscribe", subscribeLimiter, async (req: Request, res: Response) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { email, wilayas, minSeverity } = parsed.data;
  const verificationToken = generateVerificationToken();
  const unsubscribeToken = generateVerificationToken();
  const verificationExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();

  try {
    const { getDb, isAdminDb } = await import("../firebase.js");
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: "Database not available" });
      return;
    }

    if (isAdminDb(db)) {
      const existing = await db.collection("subscribers").where("email", "==", email).get();
      if (!existing.empty) {
        await existing.docs[0].ref.update({
          wilayas: wilayas || [],
          minSeverity: minSeverity || "medium",
          verificationToken,
          verificationExpiresAt,
          unsubscribeToken,
          updatedAt: new Date().toISOString(),
        });
        await sendVerificationEmail(email, verificationToken);
        res.json({ success: true, message: "Subscription updated. Check email to verify." });
        return;
      }
      await db.collection("subscribers").add({
        email, wilayas: wilayas || [], minSeverity: minSeverity || "medium",
        verified: false, verificationToken, verificationExpiresAt, unsubscribeToken, createdAt: new Date().toISOString(),
      });
    } else {
      const { collection, getDocs, query, where, addDoc, updateDoc, doc } = await import("firebase/firestore");
      const subsCol = collection(db, "subscribers");
      const q = query(subsCol, where("email", "==", email));
      const snap = await getDocs(q);
      if (!snap.empty) {
        await updateDoc(doc(db, "subscribers", snap.docs[0].id), {
          wilayas: wilayas || [], minSeverity: minSeverity || "medium",
          verificationToken, verificationExpiresAt, unsubscribeToken, updatedAt: new Date().toISOString(),
        });
        await sendVerificationEmail(email, verificationToken);
        res.json({ success: true, message: "Subscription updated. Check email to verify." });
        return;
      }
      await addDoc(subsCol, {
        email, wilayas: wilayas || [], minSeverity: minSeverity || "medium",
        verified: false, verificationToken, verificationExpiresAt, unsubscribeToken, createdAt: new Date().toISOString(),
      });
    }

    await sendVerificationEmail(email, verificationToken);
    logger.info({ email }, "New subscriber registered");
    res.json({ success: true, message: "Subscription created. Check email to verify." });
  } catch (err) {
    logger.error({ err }, "Failed to subscribe");
    res.status(500).json({ error: "Internal server error" });
  }
});

const unsubscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many unsubscribe requests. Try again shortly." },
});

router.post("/unsubscribe", unsubscribeLimiter, async (req: Request, res: Response) => {
  const parsed = unsubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }
  const { email, token } = parsed.data;

  try {
    const { getDb, isAdminDb } = await import("../firebase.js");
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: "Database not available" });
      return;
    }

    if (!(await deleteSubscriberByToken(email, token))) {
      res.status(403).json({ error: "Invalid unsubscribe token" });
      return;
    }

    logger.info({ email }, "Subscriber unsubscribed");
    res.json({ success: true, message: "Unsubscribed successfully" });
  } catch (err) {
    logger.error({ err }, "Failed to unsubscribe");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
const verificationSchema = z.object({ email: z.string().email().max(200), token: z.string().length(64) });
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
