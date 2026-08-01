import { Request, Response, Router } from "express";
import { wilayasStatus } from "../data.js";
import { getReportsFromFirestore } from "../db.js";
import { getLiveSatelliteData } from "./satellite.js";

const router = Router();

const SEVERITY_PRIORITY: Record<string, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function normalizeWilayaName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[éèêë]/g, "e")
    .replace(/[àâä]/g, "a")
    .replace(/[îï]/g, "i")
    .replace(/[ôö]/g, "o")
    .replace(/[ûüù]/g, "u")
    .replace(/ç/g, "c")
    .replace(/[''`]/g, " ")
    .replace(/[()\-–,._\/]/g, " ")
    .replace(
      /wilaya|wilaya de|ولاية|الجزائر|alg[ée]rie|tunisie|maroc|libye|تونس|المغرب|ليبيا/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function wilayaMatches(input: string, nameAr: string, nameFr: string): boolean {
  const normalizedInput = normalizeWilayaName(input);
  if (!normalizedInput) return false;

  const candidates = [normalizeWilayaName(nameAr), normalizeWilayaName(nameFr)];
  for (const candidate of candidates) {
    if (candidate === normalizedInput) return true;
    if (candidate.includes(normalizedInput) && normalizedInput.length >= 4) return true;
  }
  const allCandidateWords = new Set(candidates.flatMap((c) => c.split(" ")));
  const meaningfulInputWords = normalizedInput.split(" ").filter((word) => word.length >= 3);
  return (
    meaningfulInputWords.length > 0 &&
    meaningfulInputWords.every((word) => allCandidateWords.has(word))
  );
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
    const match = dynamicWilayas.find((w) =>
      wilayaMatches(rep.wilaya || "", w.nameAr, w.nameFr)
    );
    if (match) {
      match.activeFires += 1;
      const repSeverity = rep.severity || "medium";
      if ((SEVERITY_PRIORITY[repSeverity] ?? 0) > SEVERITY_PRIORITY[match.severity]) {
        match.severity = repSeverity;
      }
      if (repSeverity === "critical") match.evacuationRecommended = true;
    }
  });

  hotspots.forEach((sat: any) => {
    const match = dynamicWilayas.find((w) =>
      wilayaMatches(sat.wilaya || "", w.nameAr, w.nameFr)
    );
    if (match) {
      match.satelliteHotspots += 1;
      if (sat.confidence >= 80 && SEVERITY_PRIORITY[match.severity] < SEVERITY_PRIORITY.low) {
        match.severity = "low";
      }
    }
  });

  res.json(dynamicWilayas);
});

export default router;
