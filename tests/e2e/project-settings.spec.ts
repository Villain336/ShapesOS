// Marketr — E2E: project settings (Phase A, fix 3).
// All 6 project settings tabs render (HTTP 200, no console errors).
// A save on the General tab persists and writes a settings_project_updated
// audit row.

import { test, expect } from "@playwright/test";
import { gotoClean, loadIds, expectAudit, nowIso } from "./helpers";

const TABS = ["general", "skills", "data", "files", "automation", "publishing"] as const;

test.describe("project settings", () => {
  test("all 6 tabs render", async ({ page }) => {
    const { projectId } = loadIds();
    for (const tab of TABS) {
      await gotoClean(page, `/dashboard/projects/${projectId}/settings/${tab}`);
      // The tab nav marks the active tab with aria-current="page".
      const active = page.locator('nav[aria-label="Project settings"] [aria-current="page"]');
      await expect(active).toBeVisible({ timeout: 10000 });
      await expect(active).toHaveText(new RegExp(tab, "i"));
    }
  });

  test("general save persists and is audited", async ({ page }) => {
    const { projectId, workspaceId } = loadIds();
    const since = nowIso();

    await gotoClean(page, `/dashboard/projects/${projectId}/settings/general`);

    // Brand context textarea drives PUT /api/projects/[id]/settings (editor+).
    // Unique per run so the form is always dirty (the button enables on change).
    const brandVoice = `E2E brand voice ${Date.now()}: plain-spoken, no jargon.`;
    const brandContext = page.locator("#brand-context");
    await expect(brandContext).toBeVisible({ timeout: 10000 });
    await brandContext.fill(brandVoice);

    const saveRes = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/projects/${projectId}/settings`) &&
        r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    const res = await saveRes;
    expect(res.status(), "PUT /api/projects/[id]/settings").toBe(200);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("#brand-context")).toHaveValue(brandVoice);

    await expectAudit(page, {
      workspaceId,
      action: "settings_project_updated",
      since,
    });
  });
});
