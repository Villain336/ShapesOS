import { defineConfig } from "@playwright/test";

// The Electron smoke (Playwright `_electron`) against test/fake-server.ts.
// Run on Linux under Xvfb: `xvfb-run -a npm run smoke`.
export default defineConfig({
  testDir: "./smoke",
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: process.env.SMOKE_OUTPUT_DIR ?? "../test-results",
});
