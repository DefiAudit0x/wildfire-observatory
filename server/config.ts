import dotenv from "dotenv";
dotenv.config();

const nodeEnv = process.env.NODE_ENV || "development";
const jwtSecret = process.env.JWT_SECRET;

if (nodeEnv === "production" && (!jwtSecret || jwtSecret === "change-me-in-production")) {
  throw new Error("[FATAL] JWT_SECRET must be set to a strong random value in production");
}

const devJwtSecret = jwtSecret || "change-me-in-production";

const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv,
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  nasaFirmsKey: process.env.NASA_FIRMS_KEY || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || "",
  jwtSecret: nodeEnv === "production" ? jwtSecret! : devJwtSecret,
  corsOrigins: process.env.CORS_ORIGINS?.split(",") || ["http://localhost:3000", "http://localhost:5173"],
  logLevel: process.env.LOG_LEVEL || "info",
  sentryDsn: process.env.SENTRY_DSN || "",
  firebaseConfigPath: process.env.FIREBASE_CONFIG_PATH || "firebase-applet-config.json",
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || "",
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",
  appUrl: process.env.APP_URL || "http://localhost:3000",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: parseInt(process.env.SMTP_PORT || "587", 10),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  emailFrom: process.env.EMAIL_FROM || "noreply@observatory.novadz.com",
};

export default config;
