import { Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { collectionGet, docSet, docUpdate, docGet } from "../fs.js";
import { requireAdmin } from "../middleware.js";
import { logAdminAction } from "./audit.js";
import logger from "../logger.js";
import config from "../config.js";

const router = Router();

const PHONE_DZ = /^(?:\+213|0)(5|6|7)\d{8}$/;
const PHONE_TN = /^(?:\+216)?[2-9]\d{7}$/;
const PHONE_MA = /^(?:\+212|0)(?:5|6|7)\d{8}$/;
const PHONE_LY = /^(?:\+218|0)[2-9]\d{8}$/;
const PHONE_RULES = new RegExp(`^(?:${PHONE_DZ.source}|${PHONE_TN.source}|${PHONE_MA.source}|${PHONE_LY.source})$`);

const registerSchema = z.object({
  fullName: z.string().min(2).max(120),
  phone: z
    .string()
    .min(10)
    .max(20)
    .regex(PHONE_RULES, "Invalid phone number — expected a Maghreb number (DZ/TN/MA/LY)"),
  email: z.string().email().max(120).optional(),
  wilaya: z.string().min(2).max(120),
  type: z.enum(["volunteer", "official"]).optional(),
  idNumber: z.string().max(30).optional(),
  website: z.string().optional(),
});

const approveSchema = z.object({
  status: z.enum(["approved", "rejected", "pending"]).optional(),
  assignedCode: z.string().regex(/^[A-Z0-9]{4,12}$/, "Invalid badge code format").optional(),
  ownerName: z.string().min(2).max(120).optional(),
  type: z.enum(["official", "volunteer"]).optional(),
  wilaya: z.string().min(2).max(120).optional(),
  phone: z
    .string()
    .max(20)
    .optional(),
});

const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registrations from this device. Please try again later." },
});

const memoryRegs: any[] = [];
const MAX_MEMORY_REGS = 500;

function getPiiKey(): Buffer {
  return createHash("sha256").update("volunteer-pii:" + config.jwtSecret).digest();
}

function encryptPII(data: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getPiiKey(), iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

function decryptPII(token: string | undefined): string {
  if (!token) return "";
  try {
    const [ivB64, tagB64, dataB64] = token.split(".");
    const decipher = createDecipheriv("aes-256-gcm", getPiiKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    logger.error({ err }, "PII decryption failed");
    return "";
  }
}

/** Readable projection for admin screens — PII decrypted only when needed. */
function toReadable(r: any): any {
  return {
    ...r,
    fullName: decryptPII(r.fullName),
    phone: r.phone ? decryptPII(r.phone) : undefined,
    email: r.email ? decryptPII(r.email) : undefined,
    idNumber: r.idNumber ? decryptPII(r.idNumber) : undefined,
  };
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

router.post("/register", registerLimiter, async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid fields" });
    return;
  }
  const { fullName, phone, email, wilaya, type, idNumber, website } = parsed.data;

  if (website) {
    logger.warn({ ip: req.ip || "unknown" }, "Bot detected via honeypot — silent fake success");
    res.json({ id: `reg-fake-${crypto.randomBytes(4).toString("hex")}`, status: "pending" });
    return;
  }

  const requestedType = type || "volunteer";

  const existing = await loadRegs();
  const phoneHash = createHash("sha256").update(phone).digest("hex");
  if (existing && existing.some((r: any) => r.status !== "rejected" && r.phoneHash === phoneHash)) {
    res.status(409).json({ error: "This phone number is already registered" });
    return;
  }
  const emailHash = email ? hashOf(email.trim().toLowerCase()) : undefined;
  const normalizedEmail = email ? email.trim().toLowerCase() : "";
  if (
    existing &&
    emailHash &&
    existing.some(
      (r: any) =>
        r.status !== "rejected" &&
        (r.emailHash
          ? r.emailHash === emailHash
          : r.email && decryptPII(r.email).trim().toLowerCase() === normalizedEmail)
    )
  ) {
    res.status(409).json({ error: "This email is already registered" });
    return;
  }
  const fullNameHash = hashOf(fullName.trim().toLowerCase());
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (
    existing &&
    existing.some(
      (r: any) =>
        r.status !== "rejected" &&
        (r.fullNameHash
          ? r.fullNameHash === fullNameHash
          : decryptPII(r.fullName).trim().toLowerCase() === fullName.trim().toLowerCase()) &&
        r.wilaya === wilaya &&
        new Date(r.createdAt || 0).getTime() > thirtyDaysAgo
    )
  ) {
    res.status(409).json({ error: "A similar registration already exists in the last 30 days" });
    return;
  }

  const registration = {
    id: `reg-${crypto.randomBytes(6).toString("hex")}`,
    fullName: encryptPII(fullName),
    phone: encryptPII(phone),
    phoneHash,
    emailHash,
    fullNameHash,
    email: email ? encryptPII(email) : undefined,
    wilaya,
    type: requestedType,
    requestedType,
    idNumber: idNumber ? encryptPII(idNumber) : undefined,
    status: "pending",
    createdAt: new Date().toISOString(),
    registrationIp: req.ip || (req.headers["x-forwarded-for"] as string) || "unknown",
    userAgent: (req.headers["user-agent"] as string) || "unknown",
  };
  await docSet("volunteerRegistrations", registration.id, registration);
  memoryRegs.unshift(registration);
  if (memoryRegs.length > MAX_MEMORY_REGS) memoryRegs.length = MAX_MEMORY_REGS;
  logger.info(
    { registrationId: registration.id, ip: registration.registrationIp, wilaya, type: requestedType },
    "New volunteer registration"
  );
  res.json({ id: registration.id, status: registration.status });
});

async function loadRegs(): Promise<any[]> {
  if (memoryRegs.length === 0) {
    const fromDb = await collectionGet("volunteerRegistrations", "createdAt", 500).catch(() => null);
    if (fromDb && fromDb.length > 0) memoryRegs.push(...fromDb);
  }
  return memoryRegs;
}

router.get("/pending", requireAdmin, async (_req: Request, res: Response) => {
  const registrations = await loadRegs();
  res.json(registrations.map(toReadable));
});

router.post("/:id/approve", requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!/^[a-z0-9-]{1,64}$/.test(id)) {
    res.status(400).json({ error: "Invalid registration id" });
    return;
  }
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid approval payload", details: parsed.error.flatten() });
    return;
  }
  const { status, assignedCode, ownerName, type, wilaya, phone } = parsed.data;
  const finalStatus = status === "approved" || status === "rejected" ? status : "pending";
  const finalType = type === "official" || type === "volunteer" ? type : undefined;

  if (assignedCode) {
    const badgeExists = await docGet("badgeCodes", assignedCode).catch(() => null);
    if (badgeExists) {
      res.status(409).json({ error: "This badge code is already in use" });
      return;
    }
  }

  await docUpdate("volunteerRegistrations", id, { status: finalStatus, assignedCode });

  let reg = memoryRegs.find((r: any) => r.id === id);
  if (!reg) {
    try {
      reg = await docGet("volunteerRegistrations", id);
    } catch (err) {
      logger.error({ err, id }, "Firestore error finding registration for approval");
    }
  }
  if (reg) {
    reg.status = finalStatus;
    if (assignedCode) reg.assignedCode = assignedCode;
  }

  const readable = reg ? toReadable(reg) : undefined;

  if (finalStatus === "approved" && assignedCode) {
    const newBadge = {
      code: assignedCode,
      ownerName: ownerName || readable?.fullName || "متطوع",
      type: finalType || "volunteer",
      wilaya: wilaya || readable?.wilaya || "",
      phone: phone || readable?.phone || undefined,
      createdAt: new Date().toISOString(),
      isActive: true,
    };
    await docSet("badgeCodes", assignedCode, newBadge);
  }

  logAdminAction("volunteer.approve", { id, status: finalStatus, assignedCode }).catch(() => {});
  res.json({ success: true });
});

export default router;
