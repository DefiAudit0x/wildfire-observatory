// @vitest-environment node
// Node-only: uses fs/process.chdir/child_process, and the script under test
// resolves paths via import.meta.url, which is not a file: URL under jsdom.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadDotEnv, loadServiceAccountFile, loadServiceAccountJson } from "../scripts/deploy-rules.mjs";

const DUMMY_JSON = '{"project_id":"demo","private_key":"k","client_email":"a@b.c"}';
const SCRIPT_PATH = fileURLToPath(new URL("../scripts/deploy-rules.mjs", import.meta.url));

describe("deploy-rules credential loading (Fix 47 — DRULES-1/2)", () => {
  let tmpDir = "";
  let savedCwd = "";
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-rules-test-"));
    process.chdir(tmpDir);
    // Keep the credential keys out of process.env so each test controls
    // exactly which source is present.
    savedEnv = {};
    for (const key of ["FIREBASE_SERVICE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT_PATH", "SA_FILE", "SA_KEY_FILE"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(savedCwd);
    // Fix 47b (CodeRabbit 4685534460): unstub BEFORE restoring the saved
    // environment — otherwise unstubAllEnvs() removes a restored value
    // that stubEnv had recorded as absent.
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeEnv(content: string) {
    fs.writeFileSync(path.join(tmpDir, ".env"), content);
  }

  it("recognizes SA_KEY_FILE from process.env (DRULES-1 finding)", () => {
    vi.stubEnv("SA_KEY_FILE", "documented.json");
    expect(loadServiceAccountFile({})).toBe("documented.json");
  });

  it("recognizes SA_KEY_FILE from .env (DRULES-1 finding)", () => {
    writeEnv("SA_KEY_FILE=from-dotenv.json\n");
    expect(loadServiceAccountFile(loadDotEnv())).toBe("from-dotenv.json");
  });

  it("keeps SA_FILE ahead of SA_KEY_FILE (control)", () => {
    vi.stubEnv("SA_FILE", "sa.json");
    vi.stubEnv("SA_KEY_FILE", "documented.json");
    expect(loadServiceAccountFile({})).toBe("sa.json");
  });

  it("fails fast with no credential source (DRULES-1 finding, D2)", { timeout: 15_000 }, () => {
    const scrubbed = { ...process.env };
    for (const key of Object.keys(scrubbed)) {
      if (key.startsWith("FIREBASE_") || key.startsWith("SA_")) delete scrubbed[key];
    }
    let caught: unknown;
    try {
      execFileSync(process.execPath, [SCRIPT_PATH], {
        cwd: tmpDir,
        env: scrubbed,
        timeout: 10_000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const failure = caught as { status?: number; stderr?: Buffer };
    expect(failure.status).toBe(1);
    expect(String(failure.stderr)).toContain("No Firebase service account configured");
  });

  it("parses double-quoted single-line JSON (DRULES-2 finding)", () => {
    writeEnv(`FIREBASE_SERVICE_ACCOUNT="${DUMMY_JSON}"\n`);
    const env = loadDotEnv();
    expect(env.FIREBASE_SERVICE_ACCOUNT).toBe(DUMMY_JSON);
    expect(loadServiceAccountJson(env).project_id).toBe("demo");
  });

  it("parses unquoted single-line JSON (DRULES-2 finding)", () => {
    writeEnv(`FIREBASE_SERVICE_ACCOUNT=${DUMMY_JSON}\n`);
    const env = loadDotEnv();
    expect(env.FIREBASE_SERVICE_ACCOUNT).toBe(DUMMY_JSON);
    expect(loadServiceAccountJson(env).project_id).toBe("demo");
  });

  it("parses double-quoted multi-line JSON (DRULES-2 finding)", () => {
    writeEnv(`FIREBASE_SERVICE_ACCOUNT="{\n"project_id":"demo",\n"private_key":"k",\n"client_email":"a@b.c"\n}"\n`);
    const env = loadDotEnv();
    expect(loadServiceAccountJson(env).project_id).toBe("demo");
  });

  it("still parses a single-quoted multi-line value whole (control — guards the D3 overwrite trap)", () => {
    const multiLine = "{\n\"project_id\":\"demo\",\n\"private_key\":\"k\",\n\"client_email\":\"a@b.c\"\n}";
    writeEnv(`FIREBASE_SERVICE_ACCOUNT='${multiLine}'\n`);
    const env = loadDotEnv();
    expect(env.FIREBASE_SERVICE_ACCOUNT).toBe(multiLine);
    expect(loadServiceAccountJson(env).project_id).toBe("demo");
  });

  it("parses a single-quoted multi-line value followed by a blank line (Fix 47b — CodeRabbit 4685534436)", () => {
    const multiLine = "{\n\"project_id\":\"demo\",\n\"private_key\":\"k\",\n\"client_email\":\"a@b.c\"\n}";
    writeEnv(`FIREBASE_SERVICE_ACCOUNT='${multiLine}'\n\nSA_KEY_FILE=account.json\n`);
    const env = loadDotEnv();
    expect(env.FIREBASE_SERVICE_ACCOUNT).toBe(multiLine);
    expect(loadServiceAccountJson(env).project_id).toBe("demo");
    expect(loadServiceAccountFile(env)).toBe("account.json");
  });

  it("parses a double-quoted multi-line value followed by a comment line (Fix 47b — CodeRabbit 4685534436)", () => {
    const multiLine = "{\n\"project_id\":\"demo\",\n\"private_key\":\"k\",\n\"client_email\":\"a@b.c\"\n}";
    writeEnv(`FIREBASE_SERVICE_ACCOUNT="${multiLine}"\n# service account for the deploy\nSA_KEY_FILE=account.json\n`);
    const env = loadDotEnv();
    expect(env.FIREBASE_SERVICE_ACCOUNT).toBe(multiLine);
    expect(loadServiceAccountJson(env).project_id).toBe("demo");
    expect(loadServiceAccountFile(env)).toBe("account.json");
  });

  it("parses a CRLF multi-line value followed by a blank line (Fix 47b — CodeRabbit 4685534436)", () => {
    const multiLine = "{\r\n\"project_id\":\"demo\",\r\n\"private_key\":\"k\",\r\n\"client_email\":\"a@b.c\"\r\n}";
    writeEnv(`FIREBASE_SERVICE_ACCOUNT="${multiLine}"\r\n\r\nSA_KEY_FILE=account.json\r\n`);
    const env = loadDotEnv();
    expect(loadServiceAccountJson(env).project_id).toBe("demo");
    expect(loadServiceAccountFile(env)).toBe("account.json");
  });

  it("does not hang on many CRLF comment lines before a non-key line (Fix 47c — CodeQL #21 / CodeRabbit 4685825264)", () => {
    const multiLine = "{\r\n\"project_id\":\"demo\",\r\n\"private_key\":\"k\",\r\n\"client_email\":\"a@b.c\"\r\n}";
    const comments = Array.from({ length: 30 }, (_, i) => `# comment line ${i}`).join("\r\n");
    writeEnv(`FIREBASE_SERVICE_ACCOUNT="${multiLine}"\r\n${comments}\r\nnot-a-key-line\r\nSA_KEY_FILE=account.json\r\n`);
    const t0 = Date.now();
    const env = loadDotEnv();
    const elapsed = Date.now() - t0;
    // The 47b regex took 6.6 s on 24 such lines (parent probe); the fixed
    // one parses in milliseconds. The 2 s bound is generous on this VM
    // and still catches the blowup (30 lines on old code would take
    // minutes, and the 5 s test timeout would fire first).
    expect(elapsed).toBeLessThan(2000);
    expect(loadServiceAccountFile(env)).toBe("account.json");
  });
});
