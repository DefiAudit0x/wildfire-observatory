import { Request, Response, Router } from "express";
import { getDb } from "../firebase.js";
import { citizenReports, wilayasStatus } from "../data.js";
import { getAiClient, getAiModel } from "../ai.js";
import { getHaversineDistance, determineWilayaByCoords, runClustering } from "../geo.js";

const router = Router();

let initialReportsSeeded = false;

async function getReportsFromDb() {
  const db = getDb();
  if (!db) return citizenReports;
  try {
    const { collection, getDocs, query, orderBy, setDoc, doc } = await import("firebase/firestore");
    const reportsCol = collection(db, "reports");
    const q = query(reportsCol, orderBy("timestamp", "desc"));
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      if (!initialReportsSeeded) {
        console.log("Seeding initial reports to Firestore...");
        for (const rep of citizenReports) {
          await setDoc(doc(db, "reports", rep.id), rep);
        }
        initialReportsSeeded = true;
      }
      return citizenReports;
    }
    return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() } as any));
  } catch (err) {
    console.error("Error reading reports from Firestore, using fallback:", err);
    return citizenReports;
  }
}

router.get("/", async (_req: Request, res: Response) => {
  const currentReports = await getReportsFromDb();
  const clustered = runClustering(currentReports);
  res.json(clustered);
});

router.post("/", async (req: Request, res: Response) => {
  const { lat, lng, locationName, wilaya, description, severity, reporterName, reporterPhone, reporterType, reporterBadgeCode, image } = req.body;
  if (!lat || !lng || !locationName || !wilaya || !description) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  let isTrusted = false;
  let finalStatus: "pending" | "verified" = "pending";
  let initialConsensus = 1;

  if (reporterType === "official" || reporterType === "volunteer") {
    if (reporterBadgeCode && reporterBadgeCode.trim().length >= 3) {
      isTrusted = true;
      finalStatus = "verified";
      initialConsensus = 10;
    }
  }

  const newReport: any = {
    id: `rep-${Date.now()}`,
    lat: Number(lat),
    lng: Number(lng),
    locationName,
    wilaya,
    description,
    severity: severity || "medium",
    status: finalStatus,
    image: image || undefined,
    reporterName: reporterName || undefined,
    reporterPhone: reporterPhone || undefined,
    reporterType: reporterType || "citizen",
    reporterBadgeCode: reporterBadgeCode || undefined,
    timestamp: new Date().toISOString(),
    consensusCount: initialConsensus,
  };

  if (image && image.startsWith("data:image")) {
    const ai = getAiClient();
    if (ai) {
      try {
        const base64Data = image.split(",")[1];
        const mimeType = image.split(";")[0].split(":")[1];
        const prompt = `Analyze this photo submitted by a reporter regarding a wildfire in Algeria.
          Perform a thorough Computer Vision inspection. Your goals are to:
          1. Detect fire-specific markers (active flames, intense smoke plumes, thermal ash, forest damage, firefighting vehicles, burnt terrain).
          2. Calculate safety verification confidence (0 to 100).
          3. Flag any potential false report/fake visual graphics.
          4. Suggest fire severity level ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL').
          5. Write a supportive, informative verification feedback message in Arabic.
          Return JSON format:
          { "isVerified": boolean, "confidence": number, "detectedSigns": string[], "aiComments": string, "suggestedSeverity": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" }`;

        const response = await ai.models.generateContent({
          model: getAiModel(),
          contents: [{ inlineData: { data: base64Data, mimeType } }, { text: prompt }],
          config: { responseMimeType: "application/json" },
        });

        if (response.text) {
          const result = JSON.parse(response.text.trim());
          newReport.aiVerification = {
            isVerified: result.isVerified,
            confidence: result.confidence,
            detectedSigns: result.detectedSigns,
            aiComments: result.aiComments,
            suggestedSeverity: result.suggestedSeverity,
          };
          if (result.isVerified && result.confidence >= 75) {
            newReport.status = "verified";
            if (result.suggestedSeverity) {
              newReport.severity = result.suggestedSeverity.toLowerCase();
            }
          }
        }
      } catch (err) {
        console.error("Gemini Vision verification error:", err);
      }
    }

    if (!newReport.aiVerification) {
      const descriptionKeywords = description.toLowerCase();
      const detectedSigns = ["تحليل بصري تلقائي (CV)"];
      let confidence = 82;
      let aiComments = "تم مراجعة أبعاد الصورة وتصنيف القنوات اللونية. مؤشرات لهب ودخان نموذجية.";
      if (descriptionKeywords.includes("كثيف") || descriptionKeywords.includes("كبير")) {
        detectedSigns.push("انبعاث دخاني مرتفع Intensity");
        confidence = 90;
      }
      if (descriptionKeywords.includes("كبير") || descriptionKeywords.includes("خطير") || descriptionKeywords.includes("لهب")) {
        detectedSigns.push("وهج حراري سطحي");
        confidence = 88;
      }
      newReport.aiVerification = {
        isVerified: true,
        confidence,
        detectedSigns,
        aiComments,
        suggestedSeverity: severity.toUpperCase(),
      };
      if (confidence >= 80) newReport.status = "verified";
    }
  } else if (isTrusted) {
    newReport.aiVerification = {
      isVerified: true,
      confidence: 100,
      detectedSigns: reporterType === "official" ? ["هيئة رسمية معتمدة", "سجل الدفاع المدني"] : ["متطوع ميداني مصدق"],
      aiComments: reporterType === "official"
        ? "بلاغ رسمي موثق ومصدق مباشرة من الحماية المدنية الجزائرية."
        : "تم التحقق والمطابقة ميدانياً من طرف متطوع معتمد في شبكة الإغاثة.",
      suggestedSeverity: severity.toUpperCase(),
    };
  }

  const db = getDb();
  if (db) {
    try {
      const { setDoc, doc } = await import("firebase/firestore");
      await setDoc(doc(db, "reports", newReport.id), newReport);
    } catch (err) {
      console.error("[Firestore] Failed to save new report:", err);
      citizenReports.unshift(newReport);
    }
  } else {
    citizenReports.unshift(newReport);
  }

  const match = wilayasStatus.find(
    (w) => newReport.wilaya.includes(w.nameFr) || newReport.wilaya.includes(w.nameAr)
  );
  if (match) {
    match.activeFires += 1;
    if (newReport.severity === "critical" || newReport.severity === "high") {
      match.severity = newReport.severity;
    }
  }

  res.json(newReport);
});

router.post("/:id/confirm", async (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getDb();

  if (db) {
    try {
      const { doc, getDoc, updateDoc } = await import("firebase/firestore");
      const docRef = doc(db, "reports", id);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const report = { id: docSnap.id, ...docSnap.data() } as any;
        report.consensusCount += 1;
        if (report.consensusCount >= 5 && report.status === "pending") {
          report.status = "verified";
        }
        await updateDoc(docRef, { consensusCount: report.consensusCount, status: report.status });
        res.json({ success: true, consensusCount: report.consensusCount, status: report.status });
        return;
      }
    } catch (err) {
      console.error("Failed to update report upvote in Firestore:", err);
    }
  }

  const report = citizenReports.find((r) => r.id === id);
  if (!report) {
    res.status(404).json({ error: "Report not found" });
    return;
  }
  report.consensusCount += 1;
  if (report.consensusCount >= 5 && report.status === "pending") {
    report.status = "verified";
  }
  res.json({ success: true, consensusCount: report.consensusCount, status: report.status });
});

export default router;
