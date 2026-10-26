// ShapesOS — in-product browser "Dev preview" v1: shell pixels + the
// spend-gate failure state. The page is flag-gated (SHAPES_DEV_PREVIEW=1 or
// the shapes_dev_preview cookie); the e2e app has no env flag, so the spec
// sets the cookie. Zero spend: the only mutating action (Start) must fail
// closed with the 403 spend-gate error, never reach a provider.

import { expect, test } from "@playwright/test";
import { loadIds } from "./helpers";

const SHOTS = "test-results/visual-gate";

test("dev preview browser: tab strip, tab persistence, spend-gated start", async ({ page, context }) => {
  const { projectId } = loadIds();

  // Establish the origin, then opt into the flag via the cookie.
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await context.addCookies([{ name: "shapes_dev_preview", value: "1", url: new URL(page.url()).origin }]);

  // Empty shell: tab strip with only New tab, empty-pane hint.
  await page.goto("/dashboard/browser", { waitUntil: "networkidle" });
  await expect(page.getByRole("tablist")).toBeVisible();
  await expect(page.getByText("No tabs open. Open one to see a project's dev server.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/12-browser-empty.png`, fullPage: true });

  // Open two tabs on different ports: one chip per (project, port).
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);

  // The first tab's pane: no dev sandbox exists, so the empty state plus a
  // Start preview button (the ONLY wake path).
  await expect(page.getByText("No dev preview yet. Start one to run this project's dev server here.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start preview" })).toBeVisible();

  await page.getByRole("button", { name: "New tab" }).click();
  // exact: the sidebar's "Pin <row>" buttons (e.g. "Pin Reports") also contain "port".
  await page.getByLabel("Port", { exact: true }).fill("5173");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/12b-browser-tabs.png`, fullPage: true });

  // Start must fail closed without the spend gate: visible 403-derived error,
  // no sandbox created (the GET keeps reporting the empty state).
  await page.getByRole("button", { name: "Start preview" }).click();
  await expect(page.getByText("Dev previews that run compute aren't enabled for this workspace yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start preview" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/12c-browser-spend-gate.png`, fullPage: true });

  // Tabs persist across reload (localStorage).
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("tab")).toHaveCount(2);

  // Closing both returns to the empty shell.
  for (const _ of [0, 1]) await page.getByRole("button", { name: "Close tab" }).first().click();
  await expect(page.getByText("No tabs open. Open one to see a project's dev server.")).toBeVisible();
});
