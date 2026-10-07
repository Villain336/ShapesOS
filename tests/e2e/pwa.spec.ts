// ShapesOS — E2E: the offline layer's service worker (Phase 18.3).
// Runs in the "pwa" project (service workers allowed); every other spec
// blocks them, because a controlled page never reaches "networkidle".
// Checks, against the production build: the dashboard registers
// public/sw.js and it takes control, the offline page's files are
// precached, and the read cache for this person fills from a data route.

import { test, expect } from "@playwright/test";

test.describe("offline service worker", () => {
  test("registers, controls the dashboard and fills the caches", async ({ page }) => {
    const res = await page.goto("/dashboard", { waitUntil: "load" });
    expect(res?.status(), "GET /dashboard status").toBe(200);

    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20000 });
    const scriptURL = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? "");
    expect(new URL(scriptURL).pathname, "the controlling worker").toBe("/sw.js");

    await expect
      .poll(() => page.evaluate(async () => (await caches.match("/offline.html")) != null), { timeout: 20000 })
      .toBe(true);

    // Under control now, a data read goes through the worker and lands in
    // this person's read cache ("shapes-data-<key>").
    await page.reload({ waitUntil: "load" });
    const status = await page.evaluate(async () => (await fetch("/api/desk/layout", { cache: "no-store" })).status);
    expect(status, "GET /api/desk/layout through the worker").toBe(200);
    await expect
      .poll(() => page.evaluate(async () => (await caches.keys()).some((k) => k.startsWith("shapes-data-"))), { timeout: 20000 })
      .toBe(true);
  });
});
