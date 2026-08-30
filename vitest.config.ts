import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    // ARC-L26: this suite intentionally includes ALL tests/**/*.test.{ts,tsx}.
    // The 2 component specs NEED jsdom; the ~12 frontend logic specs are
    // environment-agnostic; the remaining server specs re-run here as a
    // cross-environment compatibility net. The node-native run of the same
    // files lives in vitest.server.config.ts (test:server). De-duplicating
    // would require reorganizing 51 test files — tracked under audit L26.
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    env: {
      SKIP_FIREBASE: "true",
    },
  },
});
