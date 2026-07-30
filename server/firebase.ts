import fs from "fs";
import path from "path";
import { initializeApp as initializeAdminApp, cert, getApps as getAdminApps } from "firebase-admin/app";
import { getFirestore as getAdminFirestore, Firestore as AdminFirestore } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { getFirestore, Firestore } from "firebase/firestore";
import config from "./config.js";
import logger from "./logger.js";

let adminDb: AdminFirestore | null = null;
let clientDb: Firestore | null = null;
let initialized = false;
let _isAdmin = false;

export function getDb(): Firestore | AdminFirestore | null {
  if (initialized) return adminDb || clientDb;
  initialized = true;

  if (process.env.SKIP_FIREBASE === "true") return null;

  const serviceAccountPath = config.firebaseServiceAccountPath;
  if (serviceAccountPath) {
    const saPath = path.isAbsolute(serviceAccountPath)
      ? serviceAccountPath
      : path.join(process.cwd(), serviceAccountPath);
    if (fs.existsSync(saPath)) {
      try {
        const serviceAccount = JSON.parse(fs.readFileSync(saPath, "utf8"));
        if (getAdminApps().length === 0) {
          initializeAdminApp({ credential: cert(serviceAccount) });
        }
        adminDb = getAdminFirestore();
        _isAdmin = true;
        logger.info("Firebase Admin initialized successfully");
        return adminDb;
      } catch (err) {
        logger.error({ err }, "Failed to initialize Firebase Admin, falling back to client SDK");
      }
    } else {
      logger.warn({ saPath }, "Firebase service account not found");
    }
  }

  const configPath = path.join(process.cwd(), config.firebaseConfigPath);
  if (!fs.existsSync(configPath)) return null;

  try {
    const fConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const firebaseApp = initializeApp(fConfig);
    clientDb = getFirestore(firebaseApp);
    logger.info("Firebase Client SDK initialized successfully");
  } catch (err) {
    logger.error({ err }, "Failed to initialize Firebase Client SDK");
  }

  return clientDb;
}

export function isAdminDb(_db: Firestore | AdminFirestore | null): _db is AdminFirestore {
  return _isAdmin;
}
