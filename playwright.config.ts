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
    command: "npm run build && node dist/server.cjs",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      NODE_ENV: "production",
      COOKIE_SECURE: "false",
      GENERAL_LIMIT_MAX: "10000",
      ENABLE_SWAGGER: "true",
      JWT_SECRET: "e2e-secret",
      ADMIN_PASSWORD: "test-admin",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      GCLOUD_PROJECT: "demo-wildfire-observatory-e2e",
      E2E_DURABLE_ASSERTION: "true",
    },
  },
});
