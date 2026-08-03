import { Request, Response, Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { collectionGet, docSet, docUpdate, docGet } from "../fs.js";
import { verifyAdminPassword } from "./admin.js";
import logger from "../logger.js";

const router = Router();

const registerSchema = z.object({
  fullName: z.string().min(2).max(120),
  phone: z.string().min(6).max(20),
  email: z.string().email().max(120).optional(),
  wilaya: z.string().min(2).max(120),
  type: z.enum(["volunteer", "official"]).optional(),
  idNumber: z.string().max(30).optional(),
});

const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registrations from this device. Please try again later." },
});

const memoryRegs: any[] = [];

router.post("/register", registerLimiter, async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const { fullName, phone, email, wilaya, type, idNumber } = parsed.data;
  const registration = {
    id: `reg-${Date.now()}`,
    fullName, phone,
    email: email || undefined,
    wilaya,
    type: "volunteer",
    requestedType: type || "volunteer",
    idNumber: idNumber || undefined,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await docSet("volunteerRegistrations", registration.id, registration);
  memoryRegs.unshift(registration);
  res.json({ id: registration.id, status: registration.status });
});

async function loadRegs(): Promise<any[]> {
  if (memoryRegs.length === 0) {
    const fromDb = await collectionGet("volunteerRegistrations", "createdAt", 100);
    if (fromDb && fromDb.length > 0) memoryRegs.push(...fromDb);
  }
  return memoryRegs;
}

router.get("/pending", async (req: Request, res: Response) => {
  const { password } = req.query;
  if (!password || !(await verifyAdminPassword(String(password)))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const registrations = await loadRegs();
  res.json(registrations);
});

router.post("/:id/approve", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { password, status, assignedCode, ownerName, type, wilaya, phone } = req.body;
  if (!password || !(await verifyAdminPassword(password))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const finalStatus = status === "approved" || status === "rejected" ? status : "pending";
  const finalType = type === "official" || type === "volunteer" ? type : undefined;

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

  if (finalStatus === "approved" && assignedCode) {
    const newBadge = {
      code: assignedCode,
      ownerName: ownerName || reg?.fullName || "متطوع",
      type: finalType || "volunteer",
      wilaya: wilaya || reg?.wilaya || "",
      phone: phone || reg?.phone || undefined,
      createdAt: new Date().toISOString(),
      isActive: true,
    };
    await docSet("badgeCodes", assignedCode, newBadge);
  }

  res.json({ success: true });
});

export default router;
