import { test, expect } from "@playwright/test";

test.describe("SOS emergency flow", () => {
  test("SOS floating button opens the emergency modal", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "أنا محاصر — نداء استغاثة", exact: true }).click();
    await expect(page.getByText(/نداء استغاثة طارئ/i)).toBeVisible({ timeout: 5000 });
  });

  test("emergency modal degrades gracefully without a location", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "أنا محاصر — نداء استغاثة", exact: true }).click();
    await expect(page.getByText(/تعذّر تحديد موقعك|Position indéterminée/i)).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: /إغلاق|Fermer/i }).click();
    await expect(page.getByText(/نداء استغاثة طارئ/i)).toHaveCount(0);
  });

  test("national emergency numbers are reachable from the report tab", async ({ page }) => {
    await page.goto("/");
    await page.click('button:has-text("إرسال بلاغ حريق")');
    const civilProtection = page.locator('a[href="tel:1021"]').first();
    await expect(civilProtection).toBeVisible({ timeout: 5000 });
    const forestLine = page.locator('a[href="tel:1070"]');
    await expect(forestLine).toBeVisible();
  });
});

test.describe("PWA shell", () => {
  test("manifest.json exposes install metadata", async ({ request }) => {
    const res = await request.get("/manifest.json");
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest.name).toContain("المرصد");
    expect(manifest.lang).toBe("ar");
    expect(manifest.dir).toBe("rtl");
    expect(manifest.display).toBe("standalone");
  });

  test("service worker serves with cache lifecycle handlers", async ({ request }) => {
    const res = await request.get("/sw.js");
    expect(res.ok()).toBeTruthy();
    const code = await res.text();
    expect(code).toContain("activate");
    expect(code).toContain("clients.claim");
  });

  test("service worker registers and activates on the client", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(navigator.serviceWorker), null, { timeout: 10000 });
    const active = await page.evaluate(
      async () => {
        const reg = await navigator.serviceWorker.ready;
        return Boolean(reg.active);
      },
      { timeout: 15000 }
    );
    expect(active).toBeTruthy();
  });

  test("app remains usable offline once the service worker is active", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 10000 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await page.reload();
    await expect(page).toHaveTitle(/المرصد|Observatoire|Observatory/i);
  });
});