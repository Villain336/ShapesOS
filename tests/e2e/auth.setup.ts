// Marketr — Playwright E2E auth setup (Phase A, fix 3).
// Signs in once through the REAL /login credentials form (ADMIN_EMAIL /
// ADMIN_PASSWORD from env) and saves the session to scripts/e2e/.auth.json.
// The "e2e" project reuses this storage state for every spec.

import { test as setup, expect } from "@playwright/test";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password";

setup("sign in as E2E admin", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Marketr" })).toBeVisible();

  await page.getByPlaceholder("Email").fill(ADMIN_EMAIL);
  await page.getByPlaceholder("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // Successful credentials login redirects to /dashboard.
  await page.waitForURL("**/dashboard**", { timeout: 15000 });
  expect(errors, "console/page errors on login").toEqual([]);

  await page.context().storageState({ path: "scripts/e2e/.auth.json" });
});
