import { Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import { encryptAead, decryptAead } from "../crypto.js";
import { collectionGet, docUpdate, docGet } from "../fs.js";
import { approveVolunteerAtomically, createVolunteerRegistrationAtomically } from "../atomic.js";
import { requireAdmin } from "../middleware.js";
import { str } from "../params.js";
import { logAdminAction, actorFromRequest } from "./audit.js";
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
  phone: z.string().min(10).max(20).regex(PHONE_RULES, "Invalid phone number — expected a Maghreb number (DZ/TN/MA/LY)"),
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
  phone: z.string().max(20).optional(),
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
function getPiiKey(): Buffer { return createHash("sha256").update("volunteer-pii:" + config.jwtSecret).digest(); }
// ARC-M09: the GCM envelope is shared (server/crypto.ts); only the key
// derivation above stays local to this route's "volunteer-pii" domain.
function encryptPII(data: string): string { return encryptAead(data, getPiiKey()); }
function decryptPII(token: string | undefined): string {
  const plain = decryptAead(token, getPiiKey());
  if (plain === null) { logger.warn("PII decryption failed"); return ""; }
  return plain.toString("utf8");
}
function toReadable(r: any): any {
  return { ...r, fullName: decryptPII(r.fullName), phone: r.phone ? decryptPII(r.phone) : undefined, email: r.email ? decryptPII(r.email) : undefined, idNumber: r.idNumber ? decryptPII(r.idNumber) : undefined };
}
function hashOf(value: string): string { return createHash("sha256").update(value).digest("hex"); }

router.post("/register", registerLimiter, async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Missing or invalid fields" }); return; }
  const { fullName, phone, email, wilaya, type, idNumber, website } = parsed.data;
  if (website) {
    logger.warn({ ip: req.ip || "unknown" }, "Bot detected via honeypot — silent fake success");
    res.json({ id: `reg-fake-${crypto.randomBytes(4).toString("hex")}`, status: "pending" });
    return;
  }
  const requestedType = type || "volunteer";
  const phoneHash = createHash("sha256").update(phone).digest("hex");
  const emailHash = email ? hashOf(email.trim().toLowerCase()) : undefined;
  const fullNameHash = hashOf(fullName.trim().toLowerCase());
  const registration = {
    id: `reg-${crypto.randomBytes(6).toString("hex")}`,
    fullName: encryptPII(fullName), phone: encryptPII(phone), phoneHash, emailHash, fullNameHash,
    email: email ? encryptPII(email) : undefined, wilaya, type: requestedType, requestedType,
    idNumber: idNumber ? encryptPII(idNumber) : undefined, status: "pending", createdAt: new Date().toISOString(),
    registrationIp: req.ip || (req.headers["x-forwarded-for"] as string) || "unknown",
    userAgent: (req.headers["user-agent"] as string) || "unknown",
  };

  const result = await createVolunteerRegistrationAtomically(registration, { phoneHash, emailHash, fullNameHash });
  if (result === "duplicate-phone") { res.status(409).json({ error: "This phone number is already registered" }); return; }
  if (result === "duplicate-email") { res.status(409).json({ error: "This email is already registered" }); return; }
  if (result === "duplicate-name") { res.status(409).json({ error: "A similar registration already exists in the last 30 days" }); return; }
  if (result === "unavailable") { res.status(503).json({ error: "Database not available" }); return; }

  memoryRegs.unshift(registration);
  if (memoryRegs.length > MAX_MEMORY_REGS) memoryRegs.length = MAX_MEMORY_REGS;
  logger.info({ registrationId: registration.id, ip: registration.registrationIp, wilaya, type: requestedType }, "New volunteer registration");
  res.json({ id: registration.id, status: registration.status });
});

async function loadRegs(): Promise<any[]> {
  // L2 fix: refresh from Firestore on every read instead of only when the
  // in-memory copy is empty — the old one-shot load froze the admin view:
  // approvals/status changes by a concurrent admin never appeared until a
  // process restart.
  const fromDb = await collectionGet("volunteerRegistrations", "createdAt", 500).catch(() => null);
  if (fromDb !== null && fromDb.length > 0) {
    memoryRegs.length = 0;
    memoryRegs.push(...fromDb);
  }
  return memoryRegs;
}
router.get("/pending", requireAdmin, async (_req: Request, res: Response) => { const registrations = await loadRegs(); res.json(registrations.map(toReadable)); });

router.post("/:id/approve", requireAdmin, async (req: Request, res: Response) => {
  const id = str(req.params.id);
  if (!/^[a-z0-9-]{1,64}$/.test(id)) { res.status(400).json({ error: "Invalid registration id" }); return; }
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid approval payload", details: parsed.error.flatten() }); return; }
  const { status, assignedCode, ownerName, type, wilaya, phone } = parsed.data;
  const finalStatus = status === "approved" || status === "rejected" ? status : "pending";
  const finalType = type === "official" || type === "volunteer" ? type : undefined;

  if (assignedCode) {
    const badgeExists = await docGet("badgeCodes", assignedCode).catch(() => null);
    if (badgeExists) { res.status(409).json({ error: "This badge code is already in use" }); return; }
  }

  let reg = memoryRegs.find((r: any) => r.id === id);
  if (!reg) {
    try { reg = await docGet("volunteerRegistrations", id); }
    catch (err) { logger.error({ err, id }, "Firestore error finding registration for approval"); }
  }
  if (!reg) { res.status(404).json({ error: "Registration not found" }); return; }
  const readable = toReadable(reg);
  // ARC-C1 fix: build the update conditionally — a bare `assignedCode: undefined`
  // used to make Firestore throw ("Cannot use undefined as a Firestore value"),
  // so every rejection (and every approval without a badge code) surfaced as a
  // misleading 503 "Database not available" and the 30-day name-reservation
  // release branch became unreachable.
  const registrationUpdate: Record<string, any> = { status: finalStatus, ...(assignedCode ? { assignedCode } : {}) };

  if (finalStatus === "approved" && assignedCode) {
    const newBadge = {
      code: assignedCode,
      ownerName: ownerName || readable.fullName || "متطوع",
      type: finalType || "volunteer",
      wilaya: wilaya || readable.wilaya || "",
      phone: phone || readable.phone || null,
      createdAt: new Date().toISOString(),
      isActive: true,
    };
    const result = await approveVolunteerAtomically(id, registrationUpdate, assignedCode, newBadge);
    if (result === "badge-exists") { res.status(409).json({ error: "This badge code is already in use" }); return; }
    if (result === "missing") { res.status(404).json({ error: "Registration not found" }); return; }
    if (result === "unavailable") { res.status(503).json({ error: "Database not available" }); return; }
  } else {
    const ok = await docUpdate("volunteerRegistrations", id, registrationUpdate);
    if (!ok) { res.status(503).json({ error: "Database not available" }); return; }
  }

  reg.status = finalStatus;
  if (assignedCode) reg.assignedCode = assignedCode;
  logAdminAction("volunteer.approve", { id, status: finalStatus, assignedCode }, actorFromRequest(req)).catch(() => {});
  res.json({ success: true });
});

export default router;
