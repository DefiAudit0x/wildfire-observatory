import { Request, Response, Router } from "express";
import jwt from "jsonwebtoken";
import config from "../config.js";
import { citizenReports } from "../data.js";
import { generateAdminToken } from "../middleware.js";
import { updateReportInFirestore, deleteReportFromFirestore } from "../db.js";

const router = Router();

router.post("/verify", (req: Request, res: Response) => {
  const { password } = req.body;
  if (!config.adminPassword) {
    if (password === "nova2026") {
      const token = generateAdminToken();
      res.json({ success: true, token });
      return;
    }
    res.status(401).json({ success: false, error: "Incorrect admin password" });
    return;
  }
  if (password === config.adminPassword) {
    const token = generateAdminToken();
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: "Incorrect admin password" });
  }
});

router.post("/reports/:id/update-status", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    jwt.verify(authHeader.split(" ")[1], config.jwtSecret);
  } catch {
    res.status(401).json({ error: "Unauthorized: invalid token" });
    return;
  }
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

router.post("/reports/:id/delete", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    jwt.verify(authHeader.split(" ")[1], config.jwtSecret);
  } catch {
    res.status(401).json({ error: "Unauthorized: invalid token" });
    return;
  }
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
