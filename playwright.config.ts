// Marketr — Playwright config for the Phase A E2E suite (fix 3).
// Targets the local preview: `next start -p 3000` against a local
// PostgreSQL, seeded via scripts/e2e/seed.mts. Run with scripts/e2e/run.sh.

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // specs share one seeded workspace; run serially.
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "scripts/e2e/report" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Fail fast on client-side crashes: every navigation helper asserts
    // no console errors (see tests/e2e/helpers.ts).
  },
  projects: [
    // 1) sign in once via the real /login form, save the session.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    // 2) every spec reuses that signed-in session.
    {
      name: "e2e",
      testMatch: /.*\.spec\.ts/,
      testIgnore: [/pwa\.spec\.ts/, /demo\.spec\.ts/],
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "scripts/e2e/.auth.json",
        // Phase 18.3: the dashboard registers a service worker (public/sw.js).
        // Requests it answers keep Playwright's "networkidle" from ever firing,
        // which every gotoClean() waits on, so these specs run without it.
        // The worker itself is covered by the "pwa" project below.
        serviceWorkers: "block",
      },
    },
    // 4) release demo walkthrough: records video (not a gate; the e2e
    //    project ignores demo.spec.ts so the suite never runs it twice).
    {
      name: "demo",
      testMatch: /demo\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "scripts/e2e/.auth.json",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
        video: { mode: "on", size: { width: 1280, height: 800 } },
      },
    },
    // 3) the offline layer's service worker, in a browser that allows it.
    {
      name: "pwa",
      testMatch: /pwa\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "scripts/e2e/.auth.json",
        serviceWorkers: "allow",
      },
    },
  ],
});
