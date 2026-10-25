// ShapesOS — release demo walkthrough (not a gate). Records the workspace-UX
// picks as a narrated-pacing video for release delivery: theme switch with
// persistence across reload, collapsible nav groups, and the chat dock
// opening beside the work, drag-resizing, and closing. Runs in the "demo"
// Playwright project (video on) against the same seeded production build as
// the e2e suite; excluded from the "e2e" project so it never gates CI.

import { expect, test } from "@playwright/test";
import { loadIds } from "./helpers";

test("workspace UX walkthrough", async ({ page }) => {
  test.setTimeout(150000);
  const beat = (ms = 1400) => page.waitForTimeout(ms);

  // 1. Light shell: pinned Chat/Feed rows and the nav groups. Record on a
  //    project page: /dashboard Home redirects admins to the onboarding
  //    wizard in the seeded e2e workspace (onboardingCompletedAt null),
  //    which would fill the video with setup instead of the workspace.
  const { projectId } = loadIds();
  await page.goto(`/dashboard/projects/${projectId}`, { waitUntil: "networkidle" });
  await beat(2200);

  // 2. Collapse a nav group, then re-expand it.
  const groupHeading = page.getByRole("button", { name: /^Collapse / }).first();
  await groupHeading.scrollIntoViewIfNeeded();
  const groupName = (await groupHeading.innerText()).trim();
  await beat();
  await groupHeading.click();
  await beat();
  await page.getByRole("button", { name: new RegExp(`^Expand ${groupName}$`) }).click();
  await beat();

  // 3. One click to dark; the whole shell repaints, sidebar included.
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await beat(2000);

  // 4. The choice survives a full reload (server paint arrives dark).
  await page.reload({ waitUntil: "networkidle" });
  await beat(2000);

  // 5. Back to light before moving on.
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await beat(1200);

  // 6. The chat dock beside the work: open it and the column reflows to
  //    make room (push, not overlay).
  await page.getByRole("button", { name: "Open chat" }).click();
  const dock = page.getByRole("complementary", { name: "Chat" });
  await expect(dock).toBeVisible();
  // Let the 150ms push transition settle and linger so the reflow reads.
  const main = page.locator("[data-shell-main]");
  await expect
    .poll(() => main.evaluate((el) => parseFloat(getComputedStyle(el).marginRight)))
    .toBeGreaterThan(300);
  await beat(2000);

  // 7. Drag the divider: the dock widens, the work narrows proportionally.
  const handle = page.getByRole("separator", { name: "Resize chat panel" });
  const hb = await handle.boundingBox();
  expect(hb).not.toBeNull();
  const cy = hb!.y + hb!.height / 2;
  await page.mouse.move(hb!.x + hb!.width / 2, cy);
  await beat(400);
  await page.mouse.down();
  await page.mouse.move(hb!.x + hb!.width / 2 - 160, cy, { steps: 24 });
  await page.mouse.up();
  await beat(1800);

  // 8. Close the dock; the work column takes the space back.
  await page.getByRole("button", { name: "Close chat" }).click();
  await expect(dock).toBeHidden();
  await beat(1600);
});
