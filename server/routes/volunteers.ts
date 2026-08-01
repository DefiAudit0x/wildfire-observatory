import { Request, Response, Router } from "express";
import { z } from "zod";
import { collectionGet, docSet, docUpdate, docGet } from "../fs.js";
import { verifyAdminPassword } from "./admin.js";
import logger from "../logger.js";

const router = Router();

const registerSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().optional(),
  wilaya: z.string().min(1),
  type: z.string().optional(),
  idNumber: z.string().optional(),
});

const memoryRegs: any[] = [];

router.post("/register", async (req: Request, res: Response) => {
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
    type: type || "volunteer",
    idNumber: idNumber || undefined,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await docSet("volunteerRegistrations", registration.id, registration);
  memoryRegs.unshift(registration);
  res.json(registration);
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

  await docUpdate("volunteerRegistrations", id, { status, assignedCode });

  let reg = memoryRegs.find((r: any) => r.id === id);
  if (!reg) {
    try {
      reg = await docGet("volunteerRegistrations", id);
    } catch (err) {
      logger.error({ err, id }, "Firestore error finding registration for approval");
    }
  }
  if (reg) {
    reg.status = status;
    if (assignedCode) reg.assignedCode = assignedCode;
  }

  if (status === "approved" && assignedCode) {
    const newBadge = {
      code: assignedCode,
      ownerName: ownerName || reg?.fullName || "متطوع",
      type: type || reg?.type || "volunteer",
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
