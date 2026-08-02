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

export function getDb(): Firestore | AdminFirestore | null {
  if (initialized) return adminDb || clientDb;
  initialized = true;

  if (process.env.SKIP_FIREBASE === "true") return null;

  const databaseId = resolveDatabaseId();

  let serviceAccount: any = null;

  if (config.firebaseServiceAccount) {
    try {
      serviceAccount = JSON.parse(config.firebaseServiceAccount);
    } catch (err) {
      logger.error({ err }, "FIREBASE_SERVICE_ACCOUNT is not valid JSON");
    }
  }

  if (!serviceAccount) {
    const saPath = config.firebaseServiceAccountPath;
    if (saPath) {
      const resolvedPath = path.isAbsolute(saPath) ? saPath : path.join(process.cwd(), saPath);
      if (fs.existsSync(resolvedPath)) {
        try {
          serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
        } catch (err) {
          logger.error({ err }, "Failed to parse service account file");
        }
      } else {
        logger.warn({ saPath: resolvedPath }, "Firebase service account not found");
      }
    }
  }

  if (serviceAccount) {
    try {
      if (getAdminApps().length === 0) {
        initializeAdminApp({ credential: cert(serviceAccount) });
      }
      adminDb = databaseId
        ? getAdminFirestore(getAdminApps()[0], databaseId)
        : getAdminFirestore(getAdminApps()[0]);
      _isAdmin = true;
      logger.info({ databaseId: databaseId || "(default)" }, "Firebase Admin initialized successfully");
      return adminDb;
    } catch (err) {
      logger.error({ err }, "Failed to initialize Firebase Admin, falling back to client SDK");
    }
  }

  const configPath = path.join(process.cwd(), config.firebaseConfigPath);
  if (!fs.existsSync(configPath)) return null;

  try {
    const fConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const firebaseApp = initializeApp(fConfig);
    clientDb = databaseId
      ? getFirestore(firebaseApp, databaseId)
      : getFirestore(firebaseApp);
    logger.info({ databaseId: databaseId || "(default)" }, "Firebase Client SDK initialized successfully");
  } catch (err) {
    logger.error({ err }, "Failed to initialize Firebase Client SDK");
  }

  return clientDb;
}

export function isAdminDb(_db: Firestore | AdminFirestore | null): _db is AdminFirestore {
  return _isAdmin;
}
