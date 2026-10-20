import { defineConfig } from "vitest/config";

// Unit tests only: pure modules under src/shared plus main-process modules
// with their Electron edges injected. The Electron smoke is Playwright
// (test/playwright.config.ts), never vitest.
export default defineConfig({
  define: { __TEST_HOOKS__: "true", __DESKTOP_UPDATE_URL__: '""', __APP_VERSION__: '"0.0.0-test"' },
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    // Small and memory-light: the container's MEMORY RULE.
    maxWorkers: 2,
  },
});
