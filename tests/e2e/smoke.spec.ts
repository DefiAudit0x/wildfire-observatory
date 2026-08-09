import { test, expect } from "@playwright/test";

test.describe("Smoke tests", () => {
  test("homepage loads and shows the app title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/المرصد|Observatoire|Observatory/i);
  });

  test("homepage renders the interactive map after opening the map tab", async ({ page }) => {
    await page.goto("/");
    await page.click('button:has-text("المرصد والخريطة")');
    await expect(page.locator("#map-target").first()).toBeAttached({ timeout: 15000 });
  });

  test("API health endpoint returns OK", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("GET /api/reports returns an array", async ({ request }) => {
    const res = await request.get("/api/reports");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBeTruthy();
  });

  test("admin panel login form is visible", async ({ page }) => {
    await page.goto("/");
    await page.click('button:has-text("مشرف")');
    await expect(page.getByText(/لوحة تحكم المشرفين/i)).toBeVisible({ timeout: 5000 });
  });

  test("admin login flow succeeds with correct password", async ({ page }) => {
    // Synced with ADMIN_PASSWORD in playwright.config.ts webServer env — the
    // test runner's own shell env must not gate this scenario.
    const adminPw = "test-admin";
    await page.goto("/");
    await page.click('button:has-text("مشرف")');
    const input = page.getByPlaceholder(/mot de passe|كلمة المرور/i);
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill(adminPw);
    await page.click('button:has-text("ولوج المشرف")');
    await expect(page.getByText(/أدمن نشط/i)).toBeVisible({ timeout: 5000 });
    await page.reload();
    await page.click('button:has-text("مشرف")');
    await expect(page.getByText(/أدمن نشط/i)).toBeVisible({ timeout: 5000 });
  });

  test("reports tab shows the report form", async ({ page }) => {
    await page.goto("/");
    await page.click('button:has-text("إرسال بلاغ حريق")');
    await expect(page.getByText(/إرسال بلاغ عاجل عن حريق/i)).toBeVisible({ timeout: 5000 });
  });

  test("swagger docs page loads", async ({ page }) => {
    await page.goto("/api-docs");
    await expect(page.locator(".swagger-ui").first()).toBeAttached({ timeout: 10000 });
  });

  test("GET /api/units requires a staff token (401)", async ({ request }) => {
    const res = await request.get("/api/units");
    expect(res.status()).toBe(401);
  });

  test("GET /api/roster/:date requires a staff token (401)", async ({ request }) => {
    const res = await request.get("/api/roster/2099-01-01");
    expect(res.status()).toBe(401);
  });
});
