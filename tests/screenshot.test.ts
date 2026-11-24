// @vitest-environment node
// Node-only: uses fs/EventEmitter/spawn, and the script under test resolves
// paths via import.meta.url, which is not a file: URL under jsdom.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureScreenshots } from "../scripts/screenshot.mjs";

function makePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    screenshot: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeBrowser(pageOverrides: Record<string, unknown> = {}, mobileOverrides: Record<string, unknown> = {}) {
  const page = makePage(pageOverrides);
  const mobile = makePage(mobileOverrides);
  const browser = {
    newPage: vi.fn(async (opts: { isMobile?: boolean }) => (opts?.isMobile ? mobile : page)),
    close: vi.fn(async () => {}),
    _page: page,
    _mobile: mobile,
  };
  return browser;
}

function makeChild(overrides: Record<string, unknown> = {}) {
  return {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
    ...overrides,
  };
}

describe("screenshot capture (Fix 47 — SHOT-1/2)", () => {
  it("still closes the browser when a capture fails (SHOT-1 finding)", async () => {
    const browser = makeBrowser({
      goto: vi.fn(async () => {
        throw new Error("nav boom");
      }),
    });
    const child = makeChild();
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-test-"));
    await expect(
      captureScreenshots({
        chromium: { launch: async () => browser },
        spawnFn: () => child,
        fetchFn,
        env: {},
        outDir,
      }),
    ).rejects.toThrow("nav boom");
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("closes the browser once and records all three screenshots on success (control)", async () => {
    const browser = makeBrowser();
    const child = makeChild();
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-test-"));
    await captureScreenshots({
      chromium: { launch: async () => browser },
      spawnFn: () => child,
      fetchFn,
      env: {},
      outDir,
    });
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    const desktopPaths = (browser._page.screenshot as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].path);
    const mobilePaths = (browser._mobile.screenshot as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].path);
    expect(desktopPaths).toContain(path.join(outDir, "map-view.png"));
    expect(desktopPaths).toContain(path.join(outDir, "home-map.png"));
    expect(mobilePaths).toContain(path.join(outDir, "mobile-view.png"));
  });

  it("uses the configured PORT everywhere (SHOT-2 finding)", async () => {
    const browser = makeBrowser();
    const child = makeChild();
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-test-"));
    await captureScreenshots({
      chromium: { launch: async () => browser },
      spawnFn: () => child,
      fetchFn,
      env: { PORT: "4001" },
      outDir,
    });
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:4001/api/health");
    expect(browser._page.goto).toHaveBeenCalledWith("http://127.0.0.1:4001/", expect.anything());
    expect(browser._mobile.goto).toHaveBeenCalledWith("http://127.0.0.1:4001/", expect.anything());
  });

  it("fails fast instead of screenshotting a stranger when the child died (SHOT-2 finding)", async () => {
    const browser = makeBrowser();
    const child = makeChild({ exitCode: 1 });
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-test-"));
    await expect(
      captureScreenshots({
        chromium: { launch: async () => browser },
        spawnFn: () => child,
        fetchFn,
        env: {},
        outDir,
      }),
    ).rejects.toThrow(/exited/);
    expect(browser._page.goto).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(0);
  });

  it("defaults to port 3000 (control)", async () => {
    const browser = makeBrowser();
    const child = makeChild();
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-test-"));
    await captureScreenshots({
      chromium: { launch: async () => browser },
      spawnFn: () => child,
      fetchFn,
      env: {},
      outDir,
    });
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:3000/api/health");
    expect(browser._page.goto).toHaveBeenCalledWith("http://127.0.0.1:3000/", expect.anything());
    expect(browser._mobile.goto).toHaveBeenCalledWith("http://127.0.0.1:3000/", expect.anything());
  });
});
