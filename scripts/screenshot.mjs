#!/usr/bin/env node
// Captures README screenshots: home + map view, using the production build
// served with SKIP_FIREBASE so the static demo data renders everywhere.
// Usage: node scripts/screenshot.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const outDir = join(root, "docs", "screenshots");

// Fix 47 (SHOT-2, D6): resolve the port once, mirroring the server's
// parsePort rule (server/config.ts: Number() + integer + 1..65535, else
// 3000) — NOT `Number(env.PORT) || 3000`, which diverges for e.g.
// PORT="4001.5" (the child falls back to 3000; `||` would probe 4001.5).
export function resolvePort(env = process.env) {
  const raw = env.PORT === undefined || env.PORT === "" ? "3000" : env.PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3000;
}

// Fix 47 (SHOT-1/2, D5): the capture flow as an injectable function, so
// tests can substitute a fake chromium/spawn/fetch. The entry point runs
// only under the main-guard below (first main-guard in the repo alongside
// deploy-rules.mjs).
export async function captureScreenshots(deps = {}) {
  const {
    chromium: chromiumDep,
    spawnFn = spawn,
    fetchFn = globalThis.fetch,
    env = process.env,
    outDir: outDirOverride,
  } = deps;
  const port = resolvePort(env);
  const baseUrl = `http://127.0.0.1:${port}`;
  const out = outDirOverride ?? outDir;

  // Fix 47b (CodeRabbit 4685534445): resolve the browser dependency BEFORE
  // spawning the server — the Playwright import used to sit between the
  // spawn and the try, so a failed import left the spawned child running
  // with nothing to kill it. If the import rejects now, nothing has
  // started yet.
  const chromiumImpl = chromiumDep ?? (await import("@playwright/test")).chromium;

  const server = spawnFn(process.execPath, [join(dist, "server.cjs")], {
    cwd: root,
    env: {
      ...env,
      SKIP_FIREBASE: "true",
      NODE_ENV: "production",
      COOKIE_SECURE: "false",
      GENERAL_LIMIT_MAX: "10000",
      JWT_SECRET: "screenshot-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d));
  server.stderr.on("data", (d) => (serverOutput += d));

  const waitForServer = async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      // Fix 47 (SHOT-2, D6): a stranger on the port must not satisfy
      // readiness after the child died (e.g. EADDRINUSE) — fail fast
      // instead of screenshotting the stranger's pages.
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`Screenshot server exited during startup (exit code ${server.exitCode ?? server.signalCode})`);
      }
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        const controller = new AbortController();
        let timeout;
        const timeoutPromise = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Screenshot readiness request timed out"));
          }, remainingMs);
        });
        let res;
        try {
          res = await Promise.race([
            fetchFn(`${baseUrl}/api/health`, { signal: controller.signal }),
            timeoutPromise,
          ]);
        } finally {
          clearTimeout(timeout);
        }
        if (res.ok) {
          if (server.exitCode !== null || server.signalCode !== null) {
            throw new Error(`Screenshot server exited during startup (exit code ${server.exitCode ?? server.signalCode})`);
          }
          return;
        }
      } catch (err) {
        // The exit-code throw above must not be swallowed as "not up yet".
        if (err.message.startsWith("Screenshot server exited")) throw err;
        if (err.message === "Screenshot readiness request timed out") throw err;
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("Server did not start: " + serverOutput.slice(0, 500));
  };

  let browser;
  try {
    await waitForServer();
    mkdirSync(out, { recursive: true });

    browser = await chromiumImpl.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(out, "map-view.png"), fullPage: false });

    await page.click('button:has-text("المرصد والخريطة")');
    await page.waitForSelector("#map-target", { timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(out, "home-map.png"), fullPage: false });

    const mobile = await browser.newPage({
      viewport: { width: 412, height: 892 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1.5,
    });
    await mobile.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await mobile.waitForTimeout(800);
    await mobile.screenshot({ path: join(out, "mobile-view.png"), fullPage: false });

    console.log("Saved screenshots:");
    console.log("  docs/screenshots/map-view.png");
    console.log("  docs/screenshots/home-map.png");
    console.log("  docs/screenshots/mobile-view.png");
  } finally {
    // Fix 47 (SHOT-1, D4): close the browser here — once, on both paths.
    // It used to be block-scoped inside try and closed only on success,
    // leaking the Chromium process on any capture error. The guarded close
    // must not mask the original error or break server.kill().
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
}

// Fix 47 (D5): main-guard — importing this module (e.g. from a test) must
// not spawn the server or launch a browser. The dist check stays at entry
// level, outside the extracted function.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(join(dist, "server.cjs"))) {
    console.error("dist/server.cjs missing — run `npm run build` first.");
    process.exit(1);
  }
  captureScreenshots().catch((err) => {
    console.error("Screenshot failed:", err.message);
    process.exitCode = 1;
  });
}
