import { test, expect } from "@playwright/test";

test.describe("Smoke tests", () => {
  test("homepage loads and shows the app title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/المرصد|Observatoire|Observatory/i);
  });

  test("homepage renders the interactive map", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#map")).toBeAttached({ timeout: 10000 });
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
    await page.click('button:has-text("أدمن")');
    await expect(page.getByText(/لوحة تحكم المشرفين/i)).toBeVisible({ timeout: 5000 });
  });

  test("admin login flow succeeds with correct password", async ({ page }) => {
    const adminPw = process.env.ADMIN_PASSWORD || "test-admin";
    if (!process.env.ADMIN_PASSWORD) {
      test.skip(!process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD not set");
    }
    await page.goto("/");
    await page.click('button:has-text("أدمن")');
    const input = page.getByPlaceholder(/mot de passe|كلمة المرور/i);
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill(adminPw);
    await page.click('button:has-text("دخول")');
    await expect(page.getByText(/أدمن نشط/i)).toBeVisible({ timeout: 5000 });
  });

  test("reports tab shows the report form", async ({ page }) => {
    await page.goto("/");
    await page.click('button:has-text("بلاغ")');
    await expect(page.getByText(/الإبلاغ عن حريق/i)).toBeVisible({ timeout: 5000 });
  });

  test("swagger docs page loads", async ({ page }) => {
    await page.goto("/api-docs");
    await expect(page.locator(".swagger-ui")).toBeAttached({ timeout: 10000 });
  });
});
