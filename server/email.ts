import config from "./config.js";
import logger from "./logger.js";

type EmailPayload = { to: string; subject: string; html: string };

function getProvider(): "resend" | "brevo" | "sendgrid" | null {
  if (config.resendApiKey) return "resend";
  if (config.brevoApiKey) return "brevo";
  if (config.sendgridApiKey) return "sendgrid";
  return null;
}

async function sendEmail({ to, subject, html }: EmailPayload): Promise<void> {
  const provider = getProvider();
  if (!provider) {
    logger.warn("Email service not configured — email notifications disabled");
    return;
  }

  try {
    if (provider === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: config.emailFrom, to: [to], subject, html }),
      });
      if (!res.ok) throw new Error(`Resend API ${res.status}: ${await res.text()}`);
    } else if (provider === "brevo") {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": config.brevoApiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sender: { email: config.emailFrom },
          to: [{ email: to }],
          subject,
          htmlContent: html,
        }),
      });
      if (!res.ok) throw new Error(`Brevo API ${res.status}: ${await res.text()}`);
    } else {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.sendgridApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: config.emailFrom },
          subject,
          content: [{ type: "text/html", value: html }],
        }),
      });
      if (!res.ok) throw new Error(`SendGrid API ${res.status}: ${await res.text()}`);
    }

    logger.info({ to, provider }, "Verification email sent");
  } catch (err) {
    logger.error({ err, to, provider }, "Failed to send email");
    throw err;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildAlertHtml(report: {
  severity: string; locationName: string; wilaya: string;
  description: string; lat: number; lng: number;
  timestamp: string; reporterType: string;
}, unsubscribeUrl = `${config.appUrl}/#unsubscribe`): string {
  const colorMap: Record<string, string> = {
    critical: "#dc2626", high: "#ea580c", medium: "#ca8a04", low: "#16a34a",
  };
  const color = colorMap[report.severity] || "#6b7280";
  const locationName = escapeHtml(report.locationName);
  const wilaya = escapeHtml(report.wilaya);
  const description = escapeHtml(report.description);
  const severity = escapeHtml(report.severity);
  const reporterType = escapeHtml(report.reporterType);

  return `
<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:sans-serif">
  <table width="100%" style="max-width:600px;margin:auto;padding:20px">
    <tr><td style="text-align:center;padding:20px 0">
      <h1 style="color:#fbbf24;font-size:20px;margin:0">🔥 Algerian Wildfire and Disaster Observatory</h1>
      <p style="color:#9ca3af;font-size:12px">تنبيه آني - حرائق الغابات في شمال افريقيا</p>
    </td></tr>
    <tr><td style="background:#1a1a1a;border-radius:12px;padding:24px;border-right:4px solid ${color}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="color:#f3f4f6;font-size:16px;margin:0">${locationName}</h2>
        <span style="background:${color};color:white;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:bold">${severity.toUpperCase()}</span>
      </div>
      <p style="color:#d1d5db;font-size:13px;margin:12px 0">${description}</p>
      <table style="width:100%;font-size:12px;color:#9ca3af">
        <tr><td style="padding:4px 0">الولاية:</td><td style="font-weight:bold;color:#e5e7eb">${wilaya}</td></tr>
        <tr><td style="padding:4px 0">الإحداثيات:</td><td style="font-weight:bold;color:#e5e7eb">${report.lat}, ${report.lng}</td></tr>
        <tr><td style="padding:4px 0">الوقت:</td><td style="font-weight:bold;color:#e5e7eb">${new Date(report.timestamp).toLocaleString("ar-DZ")}</td></tr>
        <tr><td style="padding:4px 0">المبلغ:</td><td style="font-weight:bold;color:#e5e7eb">${reporterType}</td></tr>
      </table>
      <a href="${config.appUrl}" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#dc2626;color:white;text-decoration:none;border-radius:8px;font-size:13px;font-weight:bold">فتح الخريطة التفاعلية</a>
    </td></tr>
    <tr><td style="text-align:center;padding:20px;color:#6b7280;font-size:10px">
      <p>تم إرسال هذا التنبيه تلقائياً من منصة المرصد الجزائري لحرائق الغابات والكوارث</p>
      <p><a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">إلغاء الاشتراك</a></p>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

async function getVerifiedSubscribers(): Promise<Array<{ email: string; unsubscribeToken?: string }>> {
  try {
    const { getDb, isAdminDb } = await import("./firebase.js");
    const db = getDb();
    if (!db) return [];

    const subscribers: Array<{ email: string; unsubscribeToken?: string }> = [];

    if (isAdminDb(db)) {
      const snap = await db.collection("subscribers").where("verified", "==", true).get();
      snap.forEach((doc: any) => subscribers.push({ email: doc.data().email, unsubscribeToken: doc.data().unsubscribeToken }));
    } else {
      const { collection, getDocs, query, where } = await import("firebase/firestore");
      const q = query(collection(db, "subscribers"), where("verified", "==", true));
      const snap = await getDocs(q);
      snap.forEach((doc) => subscribers.push({ email: doc.data().email, unsubscribeToken: doc.data().unsubscribeToken }));
    }

    return subscribers;
  } catch (err) {
    logger.error({ err }, "Failed to fetch subscribers");
    return [];
  }
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const provider = getProvider();
  if (!provider) return;

  const verifyUrl = `${config.appUrl}/api/notifications/verify?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;

  const html = `
<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:sans-serif">
  <table width="100%" style="max-width:600px;margin:auto;padding:20px">
    <tr><td style="text-align:center;padding:20px 0">
      <h1 style="color:#fbbf24;font-size:20px;margin:0">🔥 Algerian Wildfire and Disaster Observatory</h1>
      <p style="color:#9ca3af;font-size:12px">تأكيد الاشتراك في تنبيهات الحرائق</p>
    </td></tr>
    <tr><td style="background:#1a1a1a;border-radius:12px;padding:24px;text-align:center">
      <p style="color:#f3f4f6;font-size:14px;margin:0 0 8px">مرحباً! لتأكيد اشتراكك في تنبيهات حرائق الغابات، اضغط الزر التالي:</p>
      <a href="${verifyUrl}" style="display:inline-block;margin-top:16px;padding:12px 28px;background:#dc2626;color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:bold">تأكيد الاشتراك</a>
      <p style="color:#6b7280;font-size:11px;margin-top:20px">إن لم يعمل الزر، انسخ الرابط: <span style="word-break:break-all">${verifyUrl}</span></p>
    </td></tr>
  </table>
</body>
</html>`.trim();

  await sendEmail({ to: email, subject: "تأكيد اشتراكك في تنبيهات حرائق الغابات 🔥", html });
}

export async function sendFireAlert(report: {
  severity: string; locationName: string; wilaya: string;
  description: string; lat: number; lng: number;
  timestamp: string; reporterType: string;
}): Promise<void> {
  const provider = getProvider();
  if (!provider) return;

  const subscribers = await getVerifiedSubscribers();
  if (subscribers.length === 0) return;

  const subject = `🔥 [${report.severity.toUpperCase()}] حريق في ${report.wilaya}`;

  const BATCH_SIZE = 10;
  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(({ email, unsubscribeToken }) => {
        const unsubscribeUrl = unsubscribeToken
          ? `${config.appUrl}/api/notifications/unsubscribe?email=${encodeURIComponent(email)}&token=${encodeURIComponent(unsubscribeToken)}`
          : `${config.appUrl}/#unsubscribe`;
        return sendEmail({ to: email, subject, html: buildAlertHtml(report, unsubscribeUrl) }).catch((err) => {
          logger.error({ err, email }, "Failed to send alert email");
        });
      })
    );
  }

  logger.info({ count: subscribers.length, wilaya: report.wilaya }, "Fire alerts sent");
}

export { buildAlertHtml };
