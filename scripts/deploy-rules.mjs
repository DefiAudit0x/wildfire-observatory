/**
 * Deploys firestore.rules to Firebase using the service account from
 * FIREBASE_SERVICE_ACCOUNT (env), FIREBASE_SERVICE_ACCOUNT_PATH, SA_FILE, or
 * SA_KEY_FILE — no interactive login needed (relies on google-auth-library).
 *
 * Multi-line FIREBASE_SERVICE_ACCOUNT values in .env need single or double
 * quotes (the line-based loader cannot terminate an unquoted multi-line
 * value) — see loadDotEnv.
 *
 * Usage:
 *   node scripts/deploy-rules.mjs
 *   SA_KEY_FILE=firebase-service-account.json node scripts/deploy-rules.mjs
 *   FIREBASE_DATABASE_ID=<db> node scripts/deploy-rules.mjs   (release per db)
 */
import fs from "fs";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export function loadDotEnv() {
  const raw = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  const out = {};
  // Fix 47 (DRULES-2): the single-quoted-only regex silently discarded
  // double-quoted and unquoted single-line JSON. Accept both quote styles.
  // The lookahead is load-bearing: a lazy `[\s\S]*?"$` stops at the FIRST
  // `"` at a line end — which for pretty-printed JSON is the closing
  // quote of the last property's value (e.g. `"a@b.c"`), truncating the
  // value before its closing `}`. The value only ends at a quote followed
  // by a new KEY= assignment or end of input. (Single quotes need no such
  // guard: valid JSON never has `'` as a line's last character.)
  // Fix 47b (CodeRabbit 4685534436): the separators between the closing
  // quote and the next KEY= line may be blank lines, full-line comments,
  // or CRLF line endings — the first lookahead required the very next
  // line to be a KEY= assignment, so a blank line (or CRLF) after the
  // value made the whole match fail and the line parser stored only `'{'`.
  const saMatch = raw.match(/^FIREBASE_SERVICE_ACCOUNT=(?:'([\s\S]*?)'|"([\s\S]*?)")(?=(?:[ \t]*\r?\n(?:[ \t]*\r?\n|[ \t]*#[^\n]*\r?\n)*[ \t]*(?:[A-Z0-9_]+=|(?![\s\S]))|[ \t]*(?![\s\S])))/m);
  if (saMatch && !(process.env.FIREBASE_SERVICE_ACCOUNT)) out.FIREBASE_SERVICE_ACCOUNT = saMatch[1] ?? saMatch[2];
  for (const m of raw.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // Fix 47 (DRULES-2): the `!(m[1] in out)` guard is load-bearing — the
    // line parser also matches the FIRST LINE of a multi-line quoted value,
    // and without it the regex's correct whole value would be overwritten
    // with that truncated first line.
    if (!(m[1] in process.env) && !(m[1] in out)) out[m[1]] = v;
  }
  return out;
}

export function loadServiceAccountFile(env) {
  // Fix 47 (DRULES-1): SA_KEY_FILE is the documented invocation (usage
  // above) but was not recognized here. It goes AFTER the existing names
  // so precedence for existing users does not change.
  return process.env.SA_FILE || process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.SA_KEY_FILE || env.FIREBASE_SERVICE_ACCOUNT_PATH || env.SA_FILE || env.SA_KEY_FILE || null;
}

export function loadServiceAccountJson(env) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  return null;
}

async function main() {
  const env = loadDotEnv();
  const databaseId = process.env.FIREBASE_DATABASE_ID || env.FIREBASE_DATABASE_ID || "";
  const credentials = loadServiceAccountJson(env);
  const keyFile = loadServiceAccountFile(env);

  // Fix 47 (DRULES-1): fail fast with a clear error when no credential
  // source exists, before any auth attempt — otherwise the no-credential
  // path burns an ADC lookup and then dies with `readFileSync(null)`.
  if (!credentials && !keyFile) {
    throw new Error("No Firebase service account configured — set FIREBASE_SERVICE_ACCOUNT, SA_KEY_FILE, SA_FILE, or FIREBASE_SERVICE_ACCOUNT_PATH");
  }

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

// Fix 47 (D5): main-guard — importing this module (e.g. from a test) must
// not run the deploy. First main-guard in the repo; screenshot.mjs uses
// the same shape.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("✖ " + err.message);
    process.exit(1);
  });
}