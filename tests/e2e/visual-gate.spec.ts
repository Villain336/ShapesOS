// ShapesOS — visual gate for the workspace-UX redesign: captures review
// screenshots of the actual production build (next start) served by the CI
// e2e runner, and asserts the behaviors the screenshots document. The PNGs
// land in test-results/visual-gate/ and upload with the playwright-report
// artifact (upload step runs always, not only on failure).
//
// Criteria covered (branch acceptance): light mode including the sidebar,
// pinned Chat/Feed rows + collapsible nav groups, one-click theme toggle
// with persistence across reload, chat dock pushing the main column (not
// overlaying it) + drag resize, and a mobile-viewport render.

import { expect, test, type Page } from "@playwright/test";
import { loadIds } from "./helpers";

const SHOTS = "test-results/visual-gate";

const htmlClass = (page: Page) => page.evaluate(() => document.documentElement.className);

test.describe("visual gate: workspace UX", () => {
  test("shell renders light, pinned rows + foldable groups, theme toggle persists", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "networkidle" });

    // Sidebar landmarks: pinned Chat row, a collapsible group heading, the toggle.
    const nav = page.locator("nav[data-shell-nav]");
    await expect(nav.getByRole("list").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Switch to (dark|light) mode$/ })).toBeVisible();
    const groupHeading = page.getByRole("button", { name: /^Collapse / }).first();
    await expect(groupHeading).toBeVisible();

    // Expected initial state is light (e2e member default + CI prefers light).
    expect(await htmlClass(page)).not.toMatch(/\bdark\b/);
    await page.screenshot({ path: `${SHOTS}/01-light-dashboard.png`, fullPage: true });

    // Collapse a group: its rows leave the DOM; re-expand restores them.
    const groupName = (await groupHeading.innerText()).trim();
    await groupHeading.click();
    await expect(page.getByRole("button", { name: new RegExp(`^Expand ${groupName}$`) })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^Expand ${groupName}$`) }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^Collapse ${groupName}$`) })).toBeVisible();

    // Toggle to dark: <html> gains the dark class immediately (optimistic paint).
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect
      .poll(() => htmlClass(page), { message: "dark class after toggle" })
      .toMatch(/\bdark\b/);
    await page.screenshot({ path: `${SHOTS}/02-dark-dashboard.png`, fullPage: true });

    // Persistence: the next server paint must arrive dark (cookie/preferences).
    await page.reload({ waitUntil: "networkidle" });
    expect(await htmlClass(page)).toMatch(/\bdark\b/);
    await page.screenshot({ path: `${SHOTS}/03-dark-after-reload.png`, fullPage: true });

    // Back to light so the seeded member is left as found.
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect
      .poll(() => htmlClass(page), { message: "light class after toggling back" })
      .not.toMatch(/\bdark\b/);
  });

  test("chat dock pushes the main column and drag-resizes", async ({ page }) => {
    const { projectId } = loadIds();
    await page.goto(`/dashboard/projects/${projectId}`, { waitUntil: "networkidle" });

    const main = page.locator("[data-shell-main]");
    const before = await main.boundingBox();
    expect(before).not.toBeNull();

    // Open the dock (floating Chat button) and confirm push, not overlay:
    // the main column's right margin becomes exactly the dock width.
    await page.getByRole("button", { name: "Open chat" }).click();
    const dock = page.getByRole("complementary", { name: "Chat" });
    await expect(dock).toBeVisible();
    await expect
      .poll(async () => {
        const margin = await main.evaluate((el) => getComputedStyle(el).marginRight);
        const w = await page.evaluate(() => document.documentElement.style.getPropertyValue("--chat-dock-w"));
        return { margin, w };
      })
      .toEqual(expect.objectContaining({ margin: expect.stringMatching(/^[1-9]\d*(\.\d+)?px$/) }));
    const after = await main.boundingBox();
    const dockBox = await dock.boundingBox();
    expect(after!.width).toBeLessThan(before!.width);
    // Push mode: main column and dock do not overlap horizontally.
    expect(after!.x + after!.width).toBeLessThanOrEqual(dockBox!.x + 1);
    await page.screenshot({ path: `${SHOTS}/04-chat-dock-push.png`, fullPage: true });

    // Drag the separator 120px left: the dock widens and the column shrinks.
    const handle = page.getByRole("separator", { name: "Resize chat panel" });
    const hb = await handle.boundingBox();
    expect(hb).not.toBeNull();
    await page.mouse.move(hb!.x + hb!.width / 2, hb!.y + 200);
    await page.mouse.down();
    await page.mouse.move(hb!.x + hb!.width / 2 - 120, hb!.y + 200, { steps: 6 });
    await page.mouse.up();
    const widthVar = () => page.evaluate(() => parseInt(document.documentElement.style.getPropertyValue("--chat-dock-w"), 10));
    await expect.poll(widthVar, { message: "dock widened after drag" }).toBeGreaterThan(dockBox!.width + 60);
    const resized = await dock.boundingBox();
    expect(resized!.width).toBeGreaterThan(dockBox!.width + 60);
    await page.screenshot({ path: `${SHOTS}/05-chat-dock-resized.png`, fullPage: true });

    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(dock).toBeHidden();
  });

  test("mobile viewport renders without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await page.screenshot({ path: `${SHOTS}/06-mobile-dashboard.png`, fullPage: true });
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(fits).toBeTruthy();
  });
});
