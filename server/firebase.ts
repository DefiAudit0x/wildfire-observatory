import fs from "fs";
import path from "path";
import { initializeApp as initializeAdminApp, cert, getApps as getAdminApps } from "firebase-admin/app";
import { getFirestore as getAdminFirestore, Firestore as AdminFirestore } from "firebase-admin/firestore";
import config from "./config.js";
import logger from "./logger.js";

let adminDb: AdminFirestore | null = null;
let initialized = false;
let _isAdmin = false;

function resolveDatabaseId(): string {
  if (config.firestoreDatabaseId) return config.firestoreDatabaseId;
  const configPath = path.join(process.cwd(), config.firebaseConfigPath);
  if (!fs.existsSync(configPath)) return "";
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")).firestoreDatabaseId || "";
  } catch (err) {
    logger.error({ err }, "Failed to read firestoreDatabaseId from config file");
    return "";
  }
}

export function getDb(): AdminFirestore | null {
  if (initialized) return adminDb;
  initialized = true;
  if (process.env.SKIP_FIREBASE === "true") return null;

  const databaseId = resolveDatabaseId();
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST?.trim();
  let serviceAccount: unknown = null;

  if (config.firebaseServiceAccount) {
    try {
      serviceAccount = JSON.parse(config.firebaseServiceAccount);
    } catch (err) {
      logger.error({ err }, "FIREBASE_SERVICE_ACCOUNT is not valid JSON");
    }
  }

  if (!serviceAccount && config.firebaseServiceAccountPath) {
    const resolvedPath = path.isAbsolute(config.firebaseServiceAccountPath)
      ? config.firebaseServiceAccountPath
      : path.join(process.cwd(), config.firebaseServiceAccountPath);
    try {
      serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    } catch (err) {
      logger.error({ err }, "Failed to load Firebase service account");
    }
  }

  try {
    if (getAdminApps().length === 0) {
      if (emulatorHost) {
        const projectId = process.env.GCLOUD_PROJECT?.trim();
        if (!projectId) return null;
        initializeAdminApp({ projectId, ...(config.firebaseStorageBucket ? { storageBucket: config.firebaseStorageBucket } : {}) });
      } else {
        if (!serviceAccount || typeof serviceAccount !== "object") return null;
        initializeAdminApp({ credential: cert(serviceAccount), ...(config.firebaseStorageBucket ? { storageBucket: config.firebaseStorageBucket } : {}) });
      }
    }

    adminDb = databaseId
      ? getAdminFirestore(getAdminApps()[0], databaseId)
      : getAdminFirestore(getAdminApps()[0]);
    _isAdmin = true;
    return adminDb;
  } catch (err) {
    logger.error({ err }, "Failed to initialize Firebase Admin");
    return null;
  }
}

export function isAdminDb(_db: AdminFirestore | null): _db is AdminFirestore {
  return _isAdmin;
}
