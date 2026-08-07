import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "cmd /c npm run build && node dist/server.cjs",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      SKIP_FIREBASE: "true",
      NODE_ENV: "production",
      COOKIE_SECURE: "false",
      GENERAL_LIMIT_MAX: "10000",
      ENABLE_SWAGGER: "true",
      JWT_SECRET: "e2e-secret",
      ADMIN_PASSWORD: "test-admin",
    },
  },
});
