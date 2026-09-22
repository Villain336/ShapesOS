// Marketr — E2E: workspace settings (Phase A, fix 3).
// (a) All 9 workspace settings pages render (HTTP 200, no console errors).
// (b) A save on the Defaults page persists and writes a
//     settings_workspace_updated audit row.

import { test, expect } from "@playwright/test";
import { gotoClean, loadIds, expectAudit, nowIso } from "./helpers";

const PAGES = [
  { path: "skills", heading: "Skills" },
  { path: "connectors", heading: "Connectors" },
  { path: "members", heading: "Members" },
  { path: "providers", heading: "Providers" },
  { path: "governance", heading: "Governance" },
  { path: "security", heading: "Security" },
  { path: "notifications", heading: "Notifications" },
  { path: "defaults", heading: "Defaults" },
  { path: "audit", heading: "Audit" },
];

test.describe("workspace settings", () => {
  for (const p of PAGES) {
    test(`renders /dashboard/settings/${p.path}`, async ({ page }) => {
      await gotoClean(page, `/dashboard/settings/${p.path}`);
      await expect(
        page.getByRole("heading", { name: p.heading, exact: false }).first(),
      ).toBeVisible({ timeout: 10000 });
    });
  }

  test("defaults save persists and is audited", async ({ page }) => {
    const { workspaceId } = loadIds();
    const since = nowIso();

    await gotoClean(page, "/dashboard/settings/defaults");

    const modelInput = page.getByPlaceholder("e.g. gpt-4o-mini");
    await expect(modelInput).toBeVisible({ timeout: 10000 });
    await modelInput.fill("e2e-test-model");

    const saveRes = page.waitForResponse(
      (r) => r.url().includes("/api/settings/workspace") && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save defaults" }).click();
    const res = await saveRes;
    expect(res.status(), "PUT /api/settings/workspace").toBe(200);

    // Persisted: reload and the value is still there.
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByPlaceholder("e.g. gpt-4o-mini")).toHaveValue("e2e-test-model");

    await expectAudit(page, { workspaceId, action: "settings_workspace_updated", since });
  });
});
