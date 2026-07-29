import { Request, Response, Router } from "express";
import { getAiClient, getAiModel } from "../ai.js";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const { lat, lng, wilaya, lang } = req.body;
  const isArabic = lang === "ar";

  const currentReports: any[] = [];
  try {
    const { getDb } = await import("../firebase.js");
    const db = getDb();
    if (db) {
      const { collection, getDocs, query, orderBy } = await import("firebase/firestore");
      const q = query(collection(db, "reports"), orderBy("timestamp", "desc"));
      const snapshot = await getDocs(q);
      snapshot.docs.forEach((d) => currentReports.push({ id: d.id, ...d.data() }));
    }
  } catch { /* ignore */ }

  const nearbyReports = currentReports.filter((r) => {
    const latDiff = Math.abs(r.lat - (lat || 36.8));
    const lngDiff = Math.abs(r.lng - (lng || 7.5));
    return latDiff < 0.3 && lngDiff < 0.3;
  });

  const activeReportsCount = nearbyReports.length;
  const criticalReports = nearbyReports.filter((r) => r.severity === "critical" || r.severity === "high").length;

  const ai = getAiClient();
  if (ai) {
    try {
      const languageInstruction = isArabic
        ? "أجب باللغة العربية بأسلوب وقور، مطمئن، ومباشر لإنقاذ الأرواح وإعطاء إرشادات سلامة للتعامل مع دخان وحرائق الغابات."
        : "Répondez en français de manière calme, directe et rassurante afin d'aider les personnes face aux incendies.";
      const prompt = `Give a short, localized wildfire situation summary and safety guidance.
        Location: ${wilaya || "الشرق الجزائري"} (lat: ${lat || 36.8}, lng: ${lng || 7.5}).
        Active reports: ${activeReportsCount}, High/Critical: ${criticalReports}.
        ${languageInstruction}
        Structure into: 1. الوضع الميداني الحالي 2. توصيات السلامة الفورية 3. أرقام ومراكز الإغاثة.`;

      const response = await ai.models.generateContent({
        model: getAiModel(),
        contents: prompt,
      });
      res.json({ guidance: response.text });
      return;
    } catch (err) {
      console.error("AI guidance error:", err);
    }
  }

  if (isArabic) {
    res.json({
      guidance: `### 🔴 الوضع الميداني الحالي في ${wilaya || "المنطقة الشرقية"}:\nهناك نشاط متزايد لبؤر الحرائق وتصاعد للأدخنة.\n\n### 🛡️ توصيات السلامة الفورية:\n1. تجنب الطرق الجبلية والغابية.\n2. أغلق النوافذ والأبواب بإحكام.\n3. ارتدِ كمامات مبللة بالماء.\n4. استعد للإخلاء الفوري.\n\n### ☎️ أرقام الطوارئ:\n- الحماية المدنية: 1021\n- الرقم الأخضر للغابات: 1070`,
    });
  } else {
    res.json({
      guidance: `### 🔴 Situation à ${wilaya || "la région de l'Est"}:\nActivité accrue des foyers d'incendies.\n\n### 🛡️ Recommandations:\n1. Évitez les routes forestières.\n2. Fermez portes et fenêtres.\n3. Portez des masques humides.\n4. Préparez-vous à évacuer.\n\n### ☎️ Numéros d'urgence:\n- Protection Civile: 1021\n- Forêts: 1070`,
    });
  }
});

export default router;
