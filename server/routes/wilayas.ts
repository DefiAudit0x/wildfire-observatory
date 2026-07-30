import { Request, Response, Router } from "express";
import { wilayasStatus } from "../data.js";
import { getReportsFromFirestore } from "../db.js";

const router = Router();

async function getLiveSatelliteData() {
  const { satelliteHotspots } = await import("../data.js");
  return satelliteHotspots.map((sat: any) => {
    const now = new Date();
    const timePart = sat.scanTime.split("T")[1];
    const [hours, minutes] = timePart.split(":");
    now.setUTCHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
    return { ...sat, scanTime: now.toISOString() };
  });
}

router.get("/", async (_req: Request, res: Response) => {
  const firestoreReports = await getReportsFromFirestore();
  const currentReports = firestoreReports || [];
  const hotspots = await getLiveSatelliteData();

  const dynamicWilayas = wilayasStatus.map((w) => ({
    ...w,
    activeFires: 0,
    satelliteHotspots: 0,
    severity: "safe" as "safe" | "low" | "medium" | "high" | "critical" | string,
    evacuationRecommended: false,
  }));

  currentReports.forEach((rep: any) => {
    const match = dynamicWilayas.find(
      (w) => rep.wilaya.includes(w.nameFr) || rep.wilaya.includes(w.nameAr)
    );
    if (match) {
      match.activeFires += 1;
      const priority: Record<string, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };
      const repSeverity = rep.severity || "medium";
      if (priority[repSeverity] > priority[match.severity]) {
        match.severity = repSeverity;
      }
      if (repSeverity === "critical") match.evacuationRecommended = true;
    }
  });

  hotspots.forEach((sat: any) => {
    const match = dynamicWilayas.find(
      (w) => sat.wilaya.includes(w.nameFr) || sat.wilaya.includes(w.nameAr)
    );
    if (match) {
      match.satelliteHotspots += 1;
      if (sat.confidence >= 80 && match.severity === "safe") {
        match.severity = "low";
      }
    }
  });

  res.json(dynamicWilayas);
});

export default router;
