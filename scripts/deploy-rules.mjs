/**
 * Deploys firestore.rules to Firebase using the service account from
 * FIREBASE_SERVICE_ACCOUNT (env), FIREBASE_SERVICE_ACCOUNT_PATH, or SA_FILE —
 * no interactive login needed (relies on google-auth-library).
 *
 * Usage:
 *   node scripts/deploy-rules.mjs
 *   SA_KEY_FILE=firebase-service-account.json node scripts/deploy-rules.mjs
 *   FIREBASE_DATABASE_ID=<db> node scripts/deploy-rules.mjs   (release per db)
 */
import fs from "fs";
import { GoogleAuth } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

function loadDotEnv() {
  const raw = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  const out = {};
  const saMatch = raw.match(/^FIREBASE_SERVICE_ACCOUNT='([\s\S]*?)'$/m);
  if (saMatch && !(process.env.FIREBASE_SERVICE_ACCOUNT)) out.FIREBASE_SERVICE_ACCOUNT = saMatch[1];
  for (const m of raw.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
    if (m[1] === "FIREBASE_SERVICE_ACCOUNT") continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) out[m[1]] = v;
  }
  return out;
}

function loadServiceAccountFile(env) {
  return process.env.SA_FILE || process.env.FIREBASE_SERVICE_ACCOUNT_PATH || env.FIREBASE_SERVICE_ACCOUNT_PATH || env.SA_FILE || null;
}

function loadServiceAccountJson(env) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  return null;
}

async function main() {
  const env = loadDotEnv();
  const databaseId = process.env.FIREBASE_DATABASE_ID || env.FIREBASE_DATABASE_ID || "";
  const credentials = loadServiceAccountJson(env);
  const keyFile = loadServiceAccountFile(env);

  const auth = new GoogleAuth({
    ...(keyFile ? { keyFile } : {}),
    ...(credentials ? { credentials } : {}),
    scopes: SCOPES,
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const accessToken = typeof token === "string" ? token : token?.token;
  if (!accessToken) throw new Error("Could not obtain access token");

  const sa = credentials ?? JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const projectId = sa.project_id;

  const rulesRaw = fs.readFileSync("firestore.rules", "utf8");
  const ruleset = {
    source: { files: [{ name: "firestore.rules", content: rulesRaw }] },
  };
  const rs = await fetch(`https://firebaserules.googleapis.com/v1/projects/${projectId}/rulesets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(ruleset),
  });
  if (!rs.ok) throw new Error(`Ruleset create failed: ${rs.status} ${await rs.text()}`);
  const rulesetData = await rs.json();
  console.log(`✔ Ruleset created: ${rulesetData.name}`);

  const releaseIds = databaseId && !["(default)", "default"].includes(databaseId)
    ? [`cloud.firestore.${databaseId}`, `cloud.firestore/${databaseId}`]
    : ["cloud.firestore"];

  for (const releaseId of releaseIds) {
    const releaseName = `projects/${projectId}/releases/${releaseId}`;
    const releaseBody = {
      release: { name: releaseName, rulesetName: rulesetData.name },
    };
    const releaseUrl = `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/${encodeURIComponent(releaseId)}`;

    let releaseRes = await fetch(releaseUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(releaseBody),
    });

    if (!releaseRes.ok && releaseRes.status === 404) {
      releaseRes = await fetch(
        `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: releaseName, rulesetName: rulesetData.name }),
        }
      );
    }

    if (!releaseRes.ok) throw new Error(`Release failed (${releaseId}): ${releaseRes.status} ${await releaseRes.text()}`);
    const releaseData = await releaseRes.json();
    console.log(`✔ Released: ${releaseData.name} -> ${releaseData.rulesetName}`);
  }

  console.log("Firestore rules are now live.");
}

main().catch((err) => {
  console.error("✖ " + err.message);
  process.exit(1);
});