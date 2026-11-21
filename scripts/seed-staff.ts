/**
 * One-time operational seeder for the civil-protection staff backend.
 *
 * Creates:
 *   1. A civil-protection unit (if the code is not already taken)
 *   2. A staff account (superadmin or commander) bound to that unit
 *
 * Usage (from repo root, after configuring FIREBASE_SERVICE_ACCOUNT* or the applet config):
 *   npx tsx scripts/seed-staff.ts
 *
 * Env / prompts:
 *   SEED_UNIT_CODE        (e.g. DZ16)   default: DZ16
 *   SEED_UNIT_NAME_AR     default: الوحدة الرئيسية للحماية المدنية لولاية الجزائر
 *   SEED_UNIT_NAME_FR     default: Unité principale de la Protection Civile de Wilaya
 *   SEED_UNIT_WILAYA      default: 16 - الجزائر
 *   SEED_AGENT_ID         commander login id  (default: cmd-dz16)
 *   SEED_AGENT_NAME       display name         (default: قائد الوحدة)
 *   SEED_AGENT_ROLE       superadmin | commander (default: commander)
 *   SEED_AGENT_PASSWORD   password (>=8 chars, required)
 */
import bcrypt from "bcryptjs";
import { getDb } from "../server/firebase.js";
import { createDocIfAbsent } from "../server/atomic.js";

function env(key: string, def = ""): string {
  return process.env[key] || def;
}

async function main() {
  const db = getDb();
  if (!db) {
    console.error("❌ No Firestore available. Configure credentials and unset SKIP_FIREBASE first.");
    process.exit(1);
  }

  const code = (env("SEED_UNIT_CODE", "DZ16") || "DZ16").toUpperCase();
  const unitId = `unit-${code.toLowerCase()}`;
  const agentId = env("SEED_AGENT_ID", `cmd-${code.toLowerCase()}`);
  const password = env("SEED_AGENT_PASSWORD");
  if (password.length < 8) {
    console.error("❌ SEED_AGENT_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  const now = new Date().toISOString();

  {
    const unit = {
      id: unitId,
      code,
      nameAr: env("SEED_UNIT_NAME_AR", "الوحدة الرئيسية للحماية المدنية لولاية الجزائر"),
      nameFr: env("SEED_UNIT_NAME_FR", "Unité principale de la Protection Civile de Wilaya"),
      wilaya: env("SEED_UNIT_WILAYA", "16 - الجزائر"),
      createdAt: now,
      updatedAt: now,
    };
    const result = await createDocIfAbsent("units", unitId, unit);
    if (result === "unavailable") throw new Error(`Cannot safely create unit: ${unitId}`);
    console.log(result === "created" ? `✔ Unit created: ${unitId} (${code})` : `✔ Unit already exists: ${unitId}`);
  }

  {
    const role = env("SEED_AGENT_ROLE", "commander") === "superadmin" ? "superadmin" : "commander";
    const user = {
      agentId,
      name: env("SEED_AGENT_NAME", "قائد الوحدة"),
      role,
      unitId: code,
      passwordHash: await bcrypt.hash(password, 10),
      isActive: true,
      createdAt: now,
      createdBy: "seed-script",
    };
    const result = await createDocIfAbsent("users", agentId, user);
    if (result === "unavailable") throw new Error(`Cannot safely create user: ${agentId}`);
    console.log(result === "created" ? `✔ User created: ${agentId} (${role}) — name: ${user.name} — unit: ${code}` : `✔ User already exists: ${agentId} (leave untouched)`);
  }

  console.log("\nSeed finished. Login via the 'الكادر والوحدات' panel (StaffManager).");
  console.log("Permanently revoke or rotate SEED_AGENT_PASSWORD once used.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});