import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // ARC-L26: node-native run of every suite; vitest.config.ts (test:react)
    // re-runs these same files under jsdom as a compatibility net — see the
    // note there for why the two suites deliberately overlap.
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    env: {
      SKIP_FIREBASE: "true",
    },
  },
});
