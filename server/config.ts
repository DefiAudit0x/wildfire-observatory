import dotenv from "dotenv";
dotenv.config();

const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  nasaFirmsKey: process.env.NASA_FIRMS_KEY || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  corsOrigins: process.env.CORS_ORIGINS?.split(",") || ["http://localhost:3000", "http://localhost:5173"],
  logLevel: process.env.LOG_LEVEL || "info",
  sentryDsn: process.env.SENTRY_DSN || "",
  firebaseConfigPath: process.env.FIREBASE_CONFIG_PATH || "firebase-applet-config.json",
  appUrl: process.env.APP_URL || "http://localhost:3000",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
};

export default config;
