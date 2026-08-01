import { Request, Response, Router } from "express";
import { citizenReports } from "../data.js";
import { saveReportToFirestore } from "../db.js";
import { Report } from "../../src/types.js";
import logger from "../logger.js";

const router = Router();

router.post("/bulk", async (_req: Request, res: Response) => {
  const now = Date.now();
  const simReports: Report[] = [
    {
      id: `sim-${now}-1`,
      lat: 36.752,
      lng: 5.056,
      locationName: "غابات جبل يما قورايا، بجاية",
      wilaya: "الجزائر - بجاية (Algérie - Béjaïa)",
      description: "بلاغ محاكاة: اندلاع حريق غابي واسع النطاق يمتد نحو الطريق الوطني رقم 43. الرياح شمالية شرقية.",
      severity: "critical",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 18,
      reporterName: "أحمد بن عيسى (متطوع طوارئ)",
      reporterPhone: "0661223344",
      reporterType: "official",
      reporterBadgeCode: "1021",
      aiVerification: {
        isVerified: true,
        confidence: 96,
        detectedSigns: ["ألسنة لهب غابية كثيفة", "دخان أسود كثيف", "سلسلة جبلية"],
        aiComments: "تم تأكيد الحريق عبر الذكاء الاصطناعي مع توصية فورية بالإخلاء التكتيكي البري.",
        suggestedSeverity: "CRITICAL",
      },
    },
    {
      id: `sim-${now}-2`,
      lat: 36.721,
      lng: 4.051,
      locationName: "مرتفعات الأربعاء نايث إيراثن، تيزي وزو",
      wilaya: "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)",
      description: "بلاغ محاكاة: تصاعد ألسنة اللهب بالقرب من أشجار الزيتون والصنوبر. الحماية المدنية في عين المكان.",
      severity: "high",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 12,
      reporterName: "كريم حداد (فرقة غابات)",
      reporterPhone: "0770112233",
      reporterType: "official",
      reporterBadgeCode: "707",
      aiVerification: {
        isVerified: true,
        confidence: 91,
        detectedSigns: ["دخان كثيف", "غابات الصنوبر"],
        aiComments: "بؤرة حريق موثقة في منطقة حرجية.",
        suggestedSeverity: "HIGH",
      },
    },
    {
      id: `sim-${now}-3`,
      lat: 36.79,
      lng: 5.765,
      locationName: "غابات العوانة، جيجل",
      wilaya: "الجزائر - جيجل (Algérie - Jijel)",
      description: "بلاغ محاكاة: تصاعد أعمدة الدخان الكثيف بجانب المحمية الوطنية لتازة. تحذير للسائقين.",
      severity: "high",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 14,
      reporterName: "مصطفى زيان (مواطن مبلّغ)",
      reporterType: "citizen",
      aiVerification: {
        isVerified: true,
        confidence: 88,
        detectedSigns: ["دخان أسود كثيف"],
        aiComments: "بؤرة حريق معتمدة.",
        suggestedSeverity: "HIGH",
      },
    },
    {
      id: `sim-${now}-4`,
      lat: 36.42,
      lng: 3.9,
      locationName: "أحراش الأخضرية وشعب العيد، البويرة",
      wilaya: "الجزائر - البويرة (Algérie - Bouira)",
      description: "بلاغ محاكاة: النيران تقترب من المناطق السكنية الريفية، بحاجة لدعم أجهزة الإطفاء.",
      severity: "medium",
      status: "pending",
      timestamp: new Date().toISOString(),
      consensusCount: 4,
      reporterType: "citizen",
    },
    {
      id: `sim-${now}-5`,
      lat: 36.471,
      lng: 2.831,
      locationName: "مرتفعات الشريعة، البليدة",
      wilaya: "الجزائر - البليدة (Algérie - Blida)",
      description: "بلاغ محاكاة: حريق غابي في محمية الشريعة، فرقة الإطفاء متواجدة بالمكان.",
      severity: "medium",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 9,
      reporterType: "volunteer",
      reporterBadgeCode: "555",
    },
    {
      id: `sim-${now}-6`,
      lat: 36.46,
      lng: 7.43,
      locationName: "غابات جبل المائدة، قالمة",
      wilaya: "الجزائر - قالمة (Algérie - Guelma)",
      description: "بلاغ محاكاة: رصد بؤرة حريق متوسطة بالقرب من الأراضي الزراعية.",
      severity: "medium",
      status: "pending",
      timestamp: new Date().toISOString(),
      consensusCount: 3,
      reporterType: "citizen",
    },
    {
      id: `sim-${now}-7`,
      lat: 36.85,
      lng: 6.9,
      locationName: "أحراش حدائق فلفلة، سكيكدة",
      wilaya: "الجزائر - سكيكدة (Algérie - Skikda)",
      description: "بلاغ محاكاة: حريق غابي سريع الانتشار بسبب الرياح الجافة.",
      severity: "high",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 11,
      reporterType: "official",
      reporterBadgeCode: "888",
    },
  ];

  for (const rep of simReports) {
    try {
      await saveReportToFirestore(rep);
    } catch (err) {
      logger.error({ err, id: rep.id }, "Firestore bulk sim write error");
    }
    citizenReports.unshift(rep);
  }

  res.json({ success: true, count: simReports.length, reports: simReports });
});

export default router;
