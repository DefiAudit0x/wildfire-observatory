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

if (!existsSync(join(dist, "server.cjs"))) {
  console.error("dist/server.cjs missing — run `npm run build` first.");
  process.exit(1);
}

const server = spawn(process.execPath, [join(dist, "server.cjs")], {
  cwd: root,
  env: {
    ...process.env,
    SKIP_FIREBASE: "true",
    NODE_ENV: "production",
    COOKIE_SECURE: "false",
    GENERAL_LIMIT_MAX: "10000",
    ENABLE_SWAGGER: "false",
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
    try {
      const res = await fetch("http://127.0.0.1:3000/api/health");
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Server did not start: " + serverOutput.slice(0, 500));
};

const { chromium } = await import("@playwright/test");

try {
  await waitForServer();
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle" });
  await page.screenshot({ path: join(outDir, "map-view.png"), fullPage: false });

  await page.click('button:has-text("المرصد والخريطة")');
  await page.waitForSelector("#map-target", { timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(outDir, "home-map.png"), fullPage: false });

  const mobile = await browser.newPage({
    viewport: { width: 412, height: 892 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1.5,
  });
  await mobile.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle" });
  await mobile.waitForTimeout(800);
  await mobile.screenshot({ path: join(outDir, "mobile-view.png"), fullPage: false });

  await browser.close();
  console.log("Saved screenshots:");
  console.log("  docs/screenshots/map-view.png");
  console.log("  docs/screenshots/home-map.png");
  console.log("  docs/screenshots/mobile-view.png");
} catch (err) {
  console.error("Screenshot failed:", err.message);
  process.exitCode = 1;
} finally {
  server.kill();
}