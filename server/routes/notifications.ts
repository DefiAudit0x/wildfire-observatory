import { Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import logger from "../logger.js";
import config from "../config.js";
import { str } from "../params.js";
import { collectionGet, docSet, docUpdate, docGet } from "../fs.js";
import { sendVerificationEmail } from "../email.js";
import { boundDeviceId, issueDeviceCookie, ownsDevice } from "../deviceBinding.js";

const router = Router();
const unsubscribeSchema = z.object({ email: z.string().email().max(200), token: z.string().length(64) });

/**
 * ARC-M06 fix: subscribers used to be created with an auto-id after a
 * check-then-add query, so two concurrent subscribes with the same email both
 * passed the check and created duplicate documents (double fan-out on every
 * alert). A deterministic document id derived from the email makes the
 * create-vs-update race impossible: same email ⇒ same document.
 */
function subscriberId(email: string): string {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 64);
}

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
  // M4 fix: bound the in-memory fallback list like memoryRegs/memorySos/
  // memoryAudit — Firestore is the real read source, and an unbounded array
  // here is a slow memory leak on long-running deployments.
  if (memoryNotifications.length > 500) memoryNotifications.length = 500;
  return newNotif;
}

// v2.15.0: enrollment limiter — the binding endpoint is identity-adjacent,
// so it gets the same conservative shape as the other identity surfaces.
const enrollLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

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
  // M2 fix: ownership is a server-signed cookie, not a first-come plain one.
  // A valid signed cookie for the claimed device reads it; a signed cookie
  // for a DIFFERENT device is an IDOR probe — refuse.
  // v2.15.0 audit fix (device first-claim): this endpoint no longer ISSUES a
  // binding for whatever id the URL claims — identity is never read from a
  // URL. Enrollment is explicit: POST /enroll (below) binds this browser;
  // then this GET serves the bound device only.
  if (!ownsDevice(req, deviceId)) {
    const bound = (req as any).cookies?.["device_sig"];
    if (bound) {
      res.status(403).json({ error: "Device identity mismatch. Clear site data (cookies) to bind a new device.", code: "DEVICE_MISMATCH" });
    } else {
      res.status(401).json({ error: "Device enrollment required", code: "DEVICE_ENROLLMENT_REQUIRED" });
    }
    return;
  }
  const notifs = await getNotificationsFromDb(deviceId);
  res.json(notifs);
});

// v2.15.0: explicit enrollment. The signed binding cookie is issued ONLY
// here (and in the command-staff bootstrap) — never implicitly from a GET
// that echoes a client-claimed id. Rate-limited like the other identity
// surfaces so it cannot be used as a binding-refresh oracle at scale.
router.post("/enroll", enrollLimiter, async (req: Request, res: Response) => {
  const parsed = z.object({ deviceId: z.string().min(8).max(128).regex(/^web_[A-Za-z0-9_-]+$/) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid deviceId" });
    return;
  }
  const bound = boundDeviceId(req);
  if (bound && bound !== parsed.data.deviceId) {
    res.status(403).json({ error: "Device identity mismatch. Clear site data (cookies) to bind a new device.", code: "DEVICE_MISMATCH" });
    return;
  }
  issueDeviceCookie(res, parsed.data.deviceId);
  res.json({ ok: true, deviceId: parsed.data.deviceId });
});

router.post("/:id/read", async (req: Request, res: Response) => {
  const id = str(req.params.id);
  // M2 fix: the signed device cookie is the ownership proof.
  const boundId = boundDeviceId(req);
  if (!boundId) {
    res.status(403).json({ error: "Forbidden: no device binding" });
    return;
  }
  // ARC-M11 fix: ownership used to be checked by scanning the LATEST-100
  // collection window, so marking an older notification as read answered 404
  // even for its rightful owner. Ownership is a property of the notification
  // document itself — read that document directly (memory copy as fallback).
  let owned = false;
  try {
    const doc = await docGet("notifications", id);
    if (doc) {
      owned = doc.deviceId === boundId;
    } else {
      owned = memoryNotifications.some((n: any) => n.id === id && n.deviceId === boundId);
    }
  } catch {
    owned = memoryNotifications.some((n: any) => n.id === id && n.deviceId === boundId);
  }
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
  // L3 fix: bound the array and its members — an unbounded wilayas array let
  // a subscriber document balloon toward the 1 MiB Firestore doc limit.
  wilayas: z.array(z.string().max(100)).max(20).optional(),
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
      // ARC-M06 fix: deterministic id — no check-then-add duplicate window.
      const ref = db.collection("subscribers").doc(subscriberId(email));
      const existingDoc = await ref.get();
      if (existingDoc.exists) {
        await ref.update({
          email,
          wilayas: wilayas || [],
          minSeverity: minSeverity || "medium",
          verified: existingDoc.data()?.verified === true,
          verificationToken,
          verificationExpiresAt,
          unsubscribeToken,
          updatedAt: new Date().toISOString(),
        });
        await sendVerificationEmail(email, verificationToken);
        res.json({ success: true, message: "Subscription updated. Check email to verify." });
        return;
      }
      await ref.set({
        email, wilayas: wilayas || [], minSeverity: minSeverity || "medium",
        verified: false, verificationToken, verificationExpiresAt, unsubscribeToken, createdAt: new Date().toISOString(),
      });
    } else {
      const { doc, getDoc, setDoc, updateDoc } = await import("firebase/firestore");
      const ref = doc(db, "subscribers", subscriberId(email));
      const existingDoc = await getDoc(ref);
      if (existingDoc.exists()) {
        await updateDoc(ref, {
          email,
          wilayas: wilayas || [], minSeverity: minSeverity || "medium",
          verified: existingDoc.data()?.verified === true,
          verificationToken, verificationExpiresAt, unsubscribeToken, updatedAt: new Date().toISOString(),
        });
        await sendVerificationEmail(email, verificationToken);
        res.json({ success: true, message: "Subscription updated. Check email to verify." });
        return;
      }
      await setDoc(ref, {
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
