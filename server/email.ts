import nodemailer from "nodemailer";
import config from "./config.js";
import logger from "./logger.js";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  if (!config.smtpHost || !config.smtpUser || !config.smtpPass) {
    logger.warn("SMTP not configured — email notifications disabled");
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });

  return transporter;
}

function buildAlertHtml(report: {
  severity: string; locationName: string; wilaya: string;
  description: string; lat: number; lng: number;
  timestamp: string; reporterType: string;
}): string {
  const colorMap: Record<string, string> = {
    critical: "#dc2626", high: "#ea580c", medium: "#ca8a04", low: "#16a34a",
  };
  const color = colorMap[report.severity] || "#6b7280";

  return `
<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:sans-serif">
  <table width="100%" style="max-width:600px;margin:auto;padding:20px">
    <tr><td style="text-align:center;padding:20px 0">
      <h1 style="color:#fbbf24;font-size:20px;margin:0">🔥 North African Wildfire Observatory</h1>
      <p style="color:#9ca3af;font-size:12px">تنبيه آني - حرائق الغابات في شمال افريقيا</p>
    </td></tr>
    <tr><td style="background:#1a1a1a;border-radius:12px;padding:24px;border-right:4px solid ${color}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="color:#f3f4f6;font-size:16px;margin:0">${report.locationName}</h2>
        <span style="background:${color};color:white;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:bold">${report.severity.toUpperCase()}</span>
      </div>
      <p style="color:#d1d5db;font-size:13px;margin:12px 0">${report.description}</p>
      <table style="width:100%;font-size:12px;color:#9ca3af">
        <tr><td style="padding:4px 0">الولاية:</td><td style="font-weight:bold;color:#e5e7eb">${report.wilaya}</td></tr>
        <tr><td style="padding:4px 0">الإحداثيات:</td><td style="font-weight:bold;color:#e5e7eb">${report.lat}, ${report.lng}</td></tr>
        <tr><td style="padding:4px 0">الوقت:</td><td style="font-weight:bold;color:#e5e7eb">${new Date(report.timestamp).toLocaleString("ar-DZ")}</td></tr>
        <tr><td style="padding:4px 0">المبلغ:</td><td style="font-weight:bold;color:#e5e7eb">${report.reporterType}</td></tr>
      </table>
      <a href="${config.appUrl}" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#dc2626;color:white;text-decoration:none;border-radius:8px;font-size:13px;font-weight:bold">فتح الخريطة التفاعلية</a>
    </td></tr>
    <tr><td style="text-align:center;padding:20px;color:#6b7280;font-size:10px">
      <p>تم إرسال هذا التنبيه تلقائياً من منصة المرصد الشمال افريقي لحرائق الغابات</p>
      <p><a href="${config.appUrl}/#unsubscribe" style="color:#6b7280">إلغاء الاشتراك</a></p>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

async function getVerifiedSubscribers(): Promise<string[]> {
  try {
    const { getDb, isAdminDb } = await import("./firebase.js");
    const db = getDb();
    if (!db) return [];

    const emails: string[] = [];

    if (isAdminDb(db)) {
      const snap = await db.collection("subscribers").where("verified", "==", true).get();
      snap.forEach((doc: any) => emails.push(doc.data().email));
    } else {
      const { collection, getDocs, query, where } = await import("firebase/firestore");
      const q = query(collection(db, "subscribers"), where("verified", "==", true));
      const snap = await getDocs(q);
      snap.forEach((doc) => emails.push(doc.data().email));
    }

    return emails;
  } catch (err) {
    logger.error({ err }, "Failed to fetch subscribers");
    return [];
  }
}

export async function sendFireAlert(report: {
  severity: string; locationName: string; wilaya: string;
  description: string; lat: number; lng: number;
  timestamp: string; reporterType: string;
}): Promise<void> {
  const t = getTransporter();
  if (!t) return;

  const subscribers = await getVerifiedSubscribers();
  if (subscribers.length === 0) return;

  const html = buildAlertHtml(report);
  const subject = `🔥 [${report.severity.toUpperCase()}] حريق في ${report.wilaya}`;

  const BATCH_SIZE = 10;
  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map((email) =>
        t.sendMail({ from: config.emailFrom, to: email, subject, html }).catch((err) => {
          logger.error({ err, email }, "Failed to send alert email");
        })
      )
    );
  }

  logger.info({ count: subscribers.length, wilaya: report.wilaya }, "Fire alerts sent");
}

export { buildAlertHtml };
