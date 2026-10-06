// ShapesOS — E2E: accessibility of the shell (Phase 18.1, WS=find).
//
// axe-core (node_modules/axe-core, already in the tree via
// eslint-plugin-jsx-a11y — no new dependency) runs on the shell pages in
// light and dark, in English and Spanish, and with the command bar open.
// Gate: zero serious or critical violations (WCAG 2.x A/AA rules). The
// skip link must be the first Tab stop and land on <main id="main-content">.
// Preferences are switched through the app's own API (PATCH /api/preferences)
// and restored at the end.

import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { gotoClean } from "./helpers";

const require = createRequire(__filename);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const SHELL_PAGES = ["/dashboard", "/dashboard/settings", "/dashboard/settings/you/appearance", "/dashboard/approvals", "/dashboard/notifications"];

interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  nodes: Array<{ target: string[] }>;
}

async function axe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: AxeViolation[] }> } };
    const res = await w.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      resultTypes: ["violations"],
    });
    return res.violations;
  });
}

function seriousOnly(v: AxeViolation[]): string[] {
  return v
    .filter((x) => x.impact === "serious" || x.impact === "critical")
    .map((x) => `${x.impact} ${x.id}: ${x.help} — ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

async function setPrefs(page: Page, prefs: Record<string, unknown>) {
  const res = await page.request.fetch("/api/preferences", { method: "PATCH", data: prefs });
  expect(res.status(), `PATCH /api/preferences ${JSON.stringify(prefs)}`).toBe(200);
}

test.describe("shell accessibility (axe)", () => {
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: "scripts/e2e/.auth.json" });
    const page = await ctx.newPage();
    await page.request.fetch("/api/preferences", { method: "PATCH", data: { theme: "system", language: null, contrast: "standard" } });
    await ctx.close();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`no serious/critical violations — ${theme}`, async ({ page }) => {
      await setPrefs(page, { theme, language: "en" });
      for (const path of SHELL_PAGES) {
        await gotoClean(page, path);
        await expect(page.locator("html")).toHaveClass(new RegExp(`theme-${theme}`));
        expect(seriousOnly(await axe(page)), `${theme} ${path}`).toEqual([]);
      }
      // The command bar, open, with results.
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.type("set");
      await page.waitForTimeout(600);
      expect(seriousOnly(await axe(page)), `${theme} command bar`).toEqual([]);
    });
  }

  test("Spanish shell + high contrast pass too", async ({ page }) => {
    await setPrefs(page, { theme: "dark", language: "es", contrast: "high" });
    await gotoClean(page, "/dashboard/settings");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.getByRole("heading", { name: "Ajustes", exact: true })).toBeVisible();
    expect(seriousOnly(await axe(page))).toEqual([]);
  });

  test("the skip link is the first Tab stop and lands on main", async ({ page }) => {
    await setPrefs(page, { theme: "light", language: "en", contrast: "standard" });
    await gotoClean(page, "/dashboard/settings");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main-content")).toBeFocused();
    // Landmarks: one main, a navigation, a banner on desktop.
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("banner").first()).toBeVisible();
  });
});
