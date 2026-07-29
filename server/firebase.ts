import fs from "fs";
import path from "path";
import { initializeApp } from "firebase/app";
import { getFirestore, Firestore } from "firebase/firestore";
import config from "./config.js";

let db: Firestore | null = null;
let initialized = false;

export function getDb(): Firestore | null {
  if (initialized) return db;
  initialized = true;

  if (process.env.SKIP_FIREBASE === "true") return null;

  const configPath = path.join(process.cwd(), config.firebaseConfigPath);
  if (!fs.existsSync(configPath)) return null;

  try {
    const fConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const firebaseApp = initializeApp(fConfig);
    db = getFirestore(firebaseApp);
    console.log("[OK] Firebase Initialized successfully");
  } catch (err) {
    console.error("Failed to initialize Firebase:", err);
  }

  return db;
}
