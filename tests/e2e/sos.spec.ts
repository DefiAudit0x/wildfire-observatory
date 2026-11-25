import { test, expect } from "@playwright/test";

test.describe("SOS emergency flow", () => {
  test("concurrent SOS requests for one device produce one durable admission", async ({ request }) => {
    const deviceId = `e2e-sos-race-${Date.now()}`;
    const payload = { deviceId, lat: 36.75, lng: 7.6, name: "E2E", phone: "0610000000" };

    const [first, second] = await Promise.all([
      request.post("/api/sos", { data: payload }),
      request.post("/api/sos", { data: payload }),
    ]);

    expect([first.status(), second.status()].sort()).toEqual([200, 409]);

    // Fix 79 (NTESTE2ESOS-1): statuses alone do not prove a durable
    // admission — an in-memory duplicate gate could return [200, 409]
    // without persisting a usable SOS. Read the admission back twice:
    // (a) from the durable store itself, via the Firestore emulator REST
    // API (the same host the suite already uses for the report-flow reset),
    // (b) from the public API feed.
    const admitted = first.status() === 200 ? first : second;
    const created = await admitted.json();
    expect(created.id).toMatch(/^sos-/);

    const listing = await request.get(
      "http://127.0.0.1:8080/v1/projects/demo-wildfire-observatory-e2e/databases/(default)/documents/trappedSos",
      // Fix 79b: firestore.rules denies ALL client reads of trappedSos
      // ("allow read, write: if false" — server only, Admin SDK bypasses
      // rules). The emulator enforces those rules on REST calls, so an
      // unauthenticated listing is 403 PERMISSION_DENIED (proven in CI
      // attempt 3: listing.ok() false, trace shows 403 Forbidden). The
      // emulator's documented owner token bypasses the rules — emulator
      // only, never production; the server path is unchanged.
      { headers: { Authorization: "Bearer owner" } }
    );
    expect(listing.ok()).toBeTruthy();
    const docs = (await listing.json()).documents ?? [];
    const ours = docs.filter(
      (d: any) => d.fields?.deviceId?.stringValue === deviceId
    );
    expect(ours).toHaveLength(1);
    expect(ours[0].name).toContain(created.id);
    expect(Number(ours[0].fields?.lat?.doubleValue)).toBe(36.75);
    expect(Number(ours[0].fields?.lng?.doubleValue)).toBe(7.6);

    const feed = await (await request.get("/api/sos")).json();
    const visible = (Array.isArray(feed) ? feed : []).filter((s: any) => s.id === created.id);
    expect(visible).toHaveLength(1);
    expect(visible[0].status).toBe("active");
    expect(visible[0].lat).toBe(36.75);
    expect(visible[0].lng).toBe(7.6);
  });

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

  test("no-location SOS exposes all verified direct emergency fallbacks", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "أنا محاصر — نداء استغاثة", exact: true }).click();
    await expect(page.locator('a[href="tel:14"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('a[href="tel:1021"]').last()).toBeVisible();
    await expect(page.locator('a[href="tel:1070"]').last()).toBeVisible();
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

  test("service worker serves workbox-generated cache handlers", async ({ request }) => {
    const res = await request.get("/sw.js");
    expect(res.ok()).toBeTruthy();
    const code = await res.text();
    expect(code).toContain("precacheAndRoute");
    expect(code).toContain("registerRoute");
  });

  test("service worker registers and activates on the client", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(navigator.serviceWorker), null, { timeout: 10000 });
    // Fix 79 (NTESTE2ESOS-3): the old code passed { timeout: 15000 } as the
    // second argument to page.evaluate, which only forwards it to the page
    // callback (which takes no argument) — it imposed no deadline at all,
    // so a never-settling serviceWorker.ready waited out the enclosing
    // 60-second test timeout instead. waitForFunction's timeout IS a real
    // deadline: the step now fails after 15 s, not 60 s.
    await page.waitForFunction(
      () => navigator.serviceWorker.ready.then((reg) => Boolean(reg.active)).catch(() => false),
      null,
      { timeout: 15000 }
    );
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
    // Fix 79 (NTESTE2ESOS-2): the title is static HTML — cached HTML with
    // failed JavaScript/chunk loading satisfies it. The cached shell must
    // actually boot React: the emergency button must render and the report
    // tab must open the form, both with the network still offline.
    await expect(
      page.getByRole("button", { name: "أنا محاصر — نداء استغاثة", exact: true })
    ).toBeVisible({ timeout: 10000 });
    await page.click('button:has-text("إرسال بلاغ حريق")');
    await expect(page.getByText(/إرسال بلاغ عاجل عن حريق/i)).toBeVisible({ timeout: 10000 });
  });
});
