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
  firmsBaseUrl: process.env.FIRMS_BASE_URL || "https://firms.modaps.eosdis.nasa.gov/api/area/csv",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || "",
  jwtSecret: nodeEnv === "production" ? jwtSecret! : devJwtSecret,
  corsOrigins: process.env.CORS_ORIGINS?.split(",") || ["http://localhost:3000", "http://localhost:5173"],
  logLevel: process.env.LOG_LEVEL || "info",
  sentryDsn: process.env.SENTRY_DSN || "",
  firebaseConfigPath: process.env.FIREBASE_CONFIG_PATH || "firebase-applet-config.json",
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || "",
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",
  firestoreDatabaseId: process.env.FIREBASE_DATABASE_ID || "",
  appUrl: (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, ""),
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  emailFrom: process.env.EMAIL_FROM || "noreply@observatory.novadz.com",
  resendApiKey: process.env.RESEND_API_KEY || "",
  brevoApiKey: process.env.BREVO_API_KEY || "",
  sendgridApiKey: process.env.SENDGRID_API_KEY || "",
};

export default config;
