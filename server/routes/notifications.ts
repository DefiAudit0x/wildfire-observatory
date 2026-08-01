import { Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import logger from "../logger.js";
import config from "../config.js";

const router = Router();

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
          updatedAt: new Date().toISOString(),
        });
        res.json({ success: true, message: "Subscription updated. Check email to verify." });
        return;
      }
      await db.collection("subscribers").add({
        email, wilayas: wilayas || [], minSeverity: minSeverity || "medium",
        verified: false, verificationToken, createdAt: new Date().toISOString(),
      });
    } else {
      const { collection, getDocs, query, where, addDoc, updateDoc, doc } = await import("firebase/firestore");
      const subsCol = collection(db, "subscribers");
      const q = query(subsCol, where("email", "==", email));
      const snap = await getDocs(q);
      if (!snap.empty) {
        await updateDoc(doc(db, "subscribers", snap.docs[0].id), {
          wilayas: wilayas || [], minSeverity: minSeverity || "medium",
          verificationToken, updatedAt: new Date().toISOString(),
        });
        res.json({ success: true, message: "Subscription updated. Check email to verify." });
        return;
      }
      await addDoc(subsCol, {
        email, wilayas: wilayas || [], minSeverity: minSeverity || "medium",
        verified: false, verificationToken, createdAt: new Date().toISOString(),
      });
    }

    logger.info({ email }, "New subscriber registered");
    res.json({ success: true, message: "Subscription created. Check email to verify." });
  } catch (err) {
    logger.error({ err }, "Failed to subscribe");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/unsubscribe", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "Email is required" });
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
      const deletePromises: Promise<any>[] = [];
      existing.forEach((doc: any) => deletePromises.push(doc.ref.delete()));
      await Promise.all(deletePromises);
    } else {
      const { collection, getDocs, query, where, deleteDoc, doc } = await import("firebase/firestore");
      const q = query(collection(db, "subscribers"), where("email", "==", email));
      const snap = await getDocs(q);
      await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, "subscribers", d.id))));
    }

    logger.info({ email }, "Subscriber unsubscribed");
    res.json({ success: true, message: "Unsubscribed successfully" });
  } catch (err) {
    logger.error({ err }, "Failed to unsubscribe");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/verify", async (req: Request, res: Response) => {
  const { email, token } = req.query;
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
      if (!sub.verificationToken || sub.verificationToken !== token) {
        res.status(403).json({ error: "Invalid verification token" });
        return;
      }
      await existing.docs[0].ref.update({ verified: true, verificationToken: null });
    } else {
      const { collection, getDocs, query, where, updateDoc, doc } = await import("firebase/firestore");
      const q = query(collection(db, "subscribers"), where("email", "==", email));
      const snap = await getDocs(q);
      if (snap.empty) {
        res.status(404).json({ error: "Subscriber not found" });
        return;
      }
      const sub = snap.docs[0].data() as any;
      if (!sub.verificationToken || sub.verificationToken !== token) {
        res.status(403).json({ error: "Invalid verification token" });
        return;
      }
      await updateDoc(doc(db, "subscribers", snap.docs[0].id), { verified: true, verificationToken: null });
    }
    res.send("<h2>✅ اشتراكك مؤكد! سنرسل لك تنبيهات الحرائق.</h2>");
  } catch (err) {
    logger.error({ err }, "Failed to verify");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
