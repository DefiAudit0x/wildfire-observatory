import { Request, Response, Router } from "express";
import { citizenReports } from "../data.js";
import { requireAdmin, generateAdminToken } from "../middleware.js";
import { updateReportInFirestore, deleteReportFromFirestore } from "../db.js";
import logger from "../logger.js";

const router = Router();

router.post("/verify", (req: Request, res: Response) => {
  const { password } = req.body;
  if (!password) {
    res.status(400).json({ success: false, error: "Password required" });
    return;
  }
  if (password === process.env.ADMIN_PASSWORD) {
    const token = generateAdminToken();
    res.json({ success: true, token });
  } else {
    logger.warn("Failed admin login attempt");
    res.status(401).json({ success: false, error: "Incorrect admin password" });
  }
});

router.post("/reports/:id/update-status", requireAdmin, async (req: Request, res: Response) => {
  const { status, severity } = req.body;
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

router.post("/reports/:id/delete", requireAdmin, async (req: Request, res: Response) => {
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
