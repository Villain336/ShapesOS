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

// DIAG (networkidle hang hunt, run 905e451): the narrow/mid gotos below timed
// out waiting for networkidle even though the trace showed every recorded
// request complete and the page fully rendered. Track the driver's own
// request/WS events and dump what is still open when the wait times out.
function watchNetwork(page: Page) {
  const pending = new Map<string, number>();
  page.on("request", (r) => pending.set(`${r.method()} ${r.url()}`, Date.now()));
  page.on("requestfinished", (r) => pending.delete(`${r.method()} ${r.url()}`));
  page.on("requestfailed", (r) => {
    pending.delete(`${r.method()} ${r.url()}`);
    console.log("DIAG requestfailed:", r.method(), r.url(), "::", r.failure()?.errorText);
  });
  page.on("websocket", (ws) => {
    console.log("DIAG websocket open:", ws.url());
    ws.on("close", () => console.log("DIAG websocket close:", ws.url()));
    ws.on("socketerror", (e) => console.log("DIAG websocket error:", ws.url(), e));
  });
  return () => {
    console.log("DIAG still-pending at timeout:", JSON.stringify([...pending.keys()], null, 1));
  };
}

// Stat-card labels must fit their card - never collide with the corner
// icon (parent pixel gate, run 40230829776: icons struck through labels
// when the pushed work column squeezed the 4-up grid). scrollWidth >
// clientWidth is exactly the "text spills toward the icon" condition.
async function expectStatLabelsFit(page: Page) {
  const labels = ["Keywords saved", "Tracked", "Competitors", "Content items"];
  for (const label of labels) {
    const matches = await page.getByText(label, { exact: true }).all();
    expect(matches.length, `stat label "${label}" renders`).toBeGreaterThan(0);
    for (const el of matches) {
      if (!(await el.isVisible())) continue;
      const fits = await el.evaluate((n) => n.scrollWidth <= n.clientWidth + 1);
      expect(fits, `stat label "${label}" overflows its card`).toBe(true);
    }
  }
}

async function gotoWithDiag(page: Page, url: string) {
  const dump = watchNetwork(page);
  try {
    await page.goto(url, { waitUntil: "networkidle" });
  } catch (e) {
    dump();
    throw e;
  }
}


test.describe("visual gate: workspace UX", () => {
  test("shell renders light, pinned rows + foldable groups, theme toggle persists", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "networkidle" });

    // Sidebar landmarks: pinned Chat row, a collapsible group heading, the toggle.
    const nav = page.locator("nav[data-shell-nav]");
    await expect(nav.getByRole("list").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Switch to (dark|light) mode$/ })).toBeVisible();
    const groupHeading = page.getByRole("button", { name: /^Collapse / }).first();
    await expect(groupHeading).toBeVisible();

    // One route, one active row: pinned rows own /dashboard and
    // /dashboard/assistant; the matching group items stay in nav config
    // (hotkeys/⌘K/activeNavHref) but render only as the pinned row.
    // /dashboard redirects to the onboarding wizard in the seeded workspace
    // (onboardingCompletedAt null), so the pinned Chat route carries the check.
    await page.goto("/dashboard/assistant", { waitUntil: "networkidle" });
    await expect(nav.locator("[aria-current='page']")).toHaveCount(1);

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

  test("chat dock pushes the main column and drag-resizes", async ({ page }, testInfo) => {
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
    const dockBox = await dock.boundingBox();
    expect(dockBox).not.toBeNull();
    // The push transition runs 150ms (globals.css: margin-right 150ms ease).
    // Measuring mid-transition reads a fractional margin (this exact race
    // failed the first two runs: 1.86px and 12.25px "overlaps" that were
    // really settle-in-progress, confirmed on the failure pixels). Wait for
    // the column to settle at the dock's rendered width, then measure.
    await expect
      .poll(
        () => main.evaluate((el) => parseFloat(getComputedStyle(el).marginRight)),
        { message: "push margin settles at dock width" },
      )
      .toBeGreaterThan(dockBox!.width - 2);
    const after = await main.boundingBox();
    expect(after!.width).toBeLessThan(before!.width);
    // Push, not overlay: the column shrinks by exactly the dock width.
    expect(before!.width - after!.width).toBeGreaterThan(dockBox!.width - 2);
    expect(before!.width - after!.width).toBeLessThan(dockBox!.width + 2);
    // Content edges meet: the main column's right edge stops at the dock's
    // left edge (8px covers the dock's transparent 6px resize strip (w-1.5)
    // plus subpixel rounding).
    expect(after!.x + after!.width).toBeLessThanOrEqual(dockBox!.x + 8);
    await page.screenshot({ path: `${SHOTS}/04-chat-dock-push.png`, fullPage: true });
    // Viewport-only capture: fullPage stitching renders the fixed dock only
    // over the first viewport, which misreads as "content fine beneath it".
    await page.screenshot({ path: `${SHOTS}/04b-chat-dock-push-viewport.png` });
    // DIAG (parent pixel review, run 905e451): the pushed column's BOX shrinks
    // to the dock edge, but the stat cards render ~700px wide inside a ~592px
    // column - sliced at the dock edge. The margin is applied around a
    // non-shrinking child somewhere below data-shell-main. Name the elements
    // whose right edge crosses the column's right edge.
    const overflowReport = await page.evaluate(() => {
          const main = document.querySelector("[data-shell-main]")!;
          const mr = main.getBoundingClientRect();
          const bad: Array<Record<string, unknown>> = [];
          for (const el of Array.from(main.querySelectorAll("*"))) {
            const r = el.getBoundingClientRect();
            if (r.right > mr.right + 1 && r.width > 4 && r.height > 4) {
              const chain: string[] = [];
              let cur: Element | null = el;
              while (cur && cur !== main && chain.length < 5) {
                chain.push(`${cur.tagName.toLowerCase()}.${String(cur.className).split(" ").slice(0, 3).join(".")}`);
                cur = cur.parentElement;
              }
              bad.push({ chain: chain.join(" < "), right: Math.round(r.right), w: Math.round(r.width) });
              if (bad.length >= 15) break;
            }
          }
      return {
        mainRight: Math.round(mr.right),
        mainWidth: Math.round(mr.width),
        mainScrollW: (main as HTMLElement).scrollWidth,
        mainClientW: (main as HTMLElement).clientWidth,
        docScrollW: document.documentElement.scrollWidth,
        winInner: window.innerWidth,
        offenders: bad,
      };
    });
    await testInfo.attach("dock-open-overflow.json", {
      body: JSON.stringify(overflowReport, null, 1),
      contentType: "application/json",
    });
    // The pushed column's content must actually reflow into it: no element
    // may cross the column's right edge (parent pixel review, run 905e451:
    // fullPage stitching once misread this as sliced cards; the viewport
    // capture 04b/05b is the ground truth this assert mirrors numerically).
    expect(overflowReport.offenders, "content overflows the pushed column").toEqual([]);

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
    await page.screenshot({ path: `${SHOTS}/05b-chat-dock-resized-viewport.png` });
    await expectStatLabelsFit(page);

    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(dock).toBeHidden();
  });

  test("narrow desktop: dock floats over content instead of squeezing it", async ({ page }) => {
    // 980px < 1028px push threshold (288 nav + 320 dock + 420 min work):
    // overlay fallback - no push margin, full-width work column beneath.
    await page.setViewportSize({ width: 980, height: 800 });
    const { projectId } = loadIds();
    await gotoWithDiag(page, `/dashboard/projects/${projectId}`);
    await page.getByRole("button", { name: "Open chat" }).click();
    const dock = page.getByRole("complementary", { name: "Chat" });
    await expect(dock).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.chatDock ?? "unset"))
      .toBe("unset");
    const main = page.locator("[data-shell-main]");
    expect(await main.evaluate((el) => getComputedStyle(el).marginRight)).toBe("0px");
    await page.screenshot({ path: `${SHOTS}/07-narrow-overlay.png`, fullPage: true });
    await page.screenshot({ path: `${SHOTS}/07b-narrow-overlay-viewport.png` });
    await page.getByRole("button", { name: "Close chat" }).click();
  });

  test("mid desktop: a wide saved dock clamps so the work column stays usable", async ({ page }) => {
    // 1152px pushes, but a saved 720px width would leave 144px of work -
    // the clamp caps the dock at 1152 - 288 - 420 = 444px.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("shapesos:chatdock:width", "720");
      } catch {}
    });
    await page.setViewportSize({ width: 1152, height: 800 });
    const { projectId } = loadIds();
    await gotoWithDiag(page, `/dashboard/projects/${projectId}`);
    await page.getByRole("button", { name: "Open chat" }).click();
    const dock = page.getByRole("complementary", { name: "Chat" });
    await expect(dock).toBeVisible();
    await expect
      .poll(async () => (await dock.boundingBox())?.width ?? 0, { message: "dock clamps to 444px" })
      .toBeLessThanOrEqual(446);
    const main = page.locator("[data-shell-main]");
    await expect
      .poll(() => main.evaluate((el) => parseFloat(getComputedStyle(el).marginRight)))
      .toBeGreaterThan(440);
    const mb = await main.boundingBox();
    expect(1152 - mb!.x - mb!.width).toBeGreaterThan(440); // margin matches dock
    // Work column stays usable: 420 by the clamp math vs body width, 400
    // asserted to absorb a 15px classic scrollbar plus subpixel.
    expect(mb!.width).toBeGreaterThanOrEqual(400);
    await page.screenshot({ path: `${SHOTS}/08-clamped-push.png`, fullPage: true });
    await page.screenshot({ path: `${SHOTS}/08b-clamped-push-viewport.png` });
    await expectStatLabelsFit(page);
    await page.getByRole("button", { name: "Close chat" }).click();
  });

  test("mobile viewport renders without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await page.screenshot({ path: `${SHOTS}/06-mobile-dashboard.png`, fullPage: true });
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(fits).toBeTruthy();
  });
});
