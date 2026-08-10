import { test, expect } from "@playwright/test";

test.describe("Citizen report full pipeline", () => {
  test("submit via UI → persisted → confirm via map popup → consensus grows", async ({ page, request }) => {
    const before = await (await request.get("/api/reports")).json();
    const beforeCount = Array.isArray(before) ? before.length : 0;

    await page.goto("/");
    await page.click('button:has-text("إرسال بلاغ حريق")');

    await page.getByPlaceholder("36.88124").fill("36.55");
    await page.getByPlaceholder("8.41125").fill("8.05");
    await page.locator("select:visible").first().selectOption({ label: "الجزائر - الطارف" });
    await page.getByPlaceholder(/مثال: غابة جبل الوحش/).fill("غابة اختبار نظام الإنذار المبكر");
    await page
      .getByPlaceholder(/ما الذي يحترق/)
      .fill("حريق محدود في الأحراش قرب مسالك الغابة — اختبار سير كامل");

    await page.click('button:has-text("بث بلاغ الحريق الآن")');
    await expect(page.getByText("تقديم بلاغ آخر")).toBeVisible({ timeout: 15000 });

    const after = await (await request.get("/api/reports")).json();
    const reports = Array.isArray(after) ? after : [];
    expect(reports.length).toBe(beforeCount + 1);

    const submitted = reports.find((r: any) => r.locationName === "غابة اختبار نظام الإنذار المبكر");
    expect(submitted).toBeTruthy();
    expect(submitted.description).toContain("اختبار سير كامل");
    expect(submitted.lat).toBeCloseTo(36.55, 4);
    expect(submitted.lng).toBeCloseTo(8.05, 4);

    await page.click('button:has-text("المرصد والخريطة")');
    await page.waitForSelector("#map-target", { timeout: 15000 });
    await page.waitForSelector(".custom-citizen-icon", { timeout: 10000 });

    const marker = page.locator(".custom-citizen-icon").first();
    await marker.click({ force: true });
    await page.waitForSelector(".leaflet-popup [data-confirm-report]", { timeout: 10000 });

    const confirmId = await page.locator(".leaflet-popup [data-confirm-report]").first().getAttribute("data-confirm-report");
    expect(confirmId).toBeTruthy();

    const beforeConfirm = (await (await request.get("/api/reports")).json()) as any[];
    const target = beforeConfirm.find((r: any) => r.id === confirmId);
    expect(target).toBeTruthy();
    const consensusBefore = target.consensusCount ?? 0;

    await page.locator(".leaflet-popup [data-confirm-report]").first().click();

    let consensusAfter = consensusBefore;
    await expect
      .poll(async () => {
        const latest = (await (await request.get("/api/reports")).json()) as any[];
        const hit = latest.find((r: any) => r.id === confirmId);
        consensusAfter = hit?.consensusCount ?? consensusBefore;
        return consensusAfter;
      }, { timeout: 10000 })
      .toBeGreaterThan(consensusBefore);
  });
});