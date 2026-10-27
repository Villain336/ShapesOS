// ShapesOS - Store bundles (Phase 24; pixel + route evidence).
//
// The Bundles section lists curated groups with each member's state;
// connectors are only linked ("Connect separately"), never installed; the
// install needs an explicit confirm that names what will change; the route
// refuses an unconfirmed call, a member outside the bundle, and never
// installs a connector. PNGs land in test-results/store-bundles/.

import { expect, test } from "@playwright/test";
import { gotoClean } from "./helpers";

const SHOTS = "test-results/store-bundles";

test.describe("store bundles", () => {
  test("bundles list, link connectors, confirm before installing, and never install a connector", async ({ page, browser }) => {
    await gotoClean(page, "/dashboard/store");
    const section = page.getByRole("region", { name: "Bundles" });
    await expect(section).toBeVisible();
    const seo = section.locator('[data-bundle="seo-growth"]');
    const local = section.locator('[data-bundle="local-visibility"]');
    await expect(seo).toBeVisible();
    await expect(local).toBeVisible();
    await expect(seo.getByText("SEO growth kit")).toBeVisible();
    // Real members from the registries, with their kinds.
    await expect(seo.getByText("Rank Report")).toBeVisible();
    await expect(seo.getByText("Google Search Console")).toBeVisible();
    // Connectors are links to Settings, with no install checkbox.
    await expect(seo.getByRole("link", { name: "Connect separately" }).first()).toBeVisible();
    await expect(seo.getByRole("checkbox", { name: /Google Search Console/ })).toHaveCount(0);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/bundles-list.png`, fullPage: false });

    // Install exactly one member: untick the rest, then the confirm names it.
    const boxes = seo.getByRole("checkbox");
    const n = await boxes.count();
    expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      const box = boxes.nth(i);
      const label = (await box.getAttribute("aria-label")) ?? "";
      if (label !== "Install Rank Report" && (await box.isChecked())) await box.uncheck();
    }
    await expect(seo.getByRole("checkbox", { name: "Install Rank Report" })).toBeChecked();
    await seo.getByRole("button", { name: /Install selected \(1\)/ }).click();
    await expect(page.getByText(/Install 1 item from "SEO growth kit"\?/)).toBeVisible();
    await expect(page.getByText(/Not installed by this bundle: .*Google Search Console/)).toBeVisible();
    // The dialog fades in: wait for its animations to finish so the pixel shows it fully painted.
    await expect(page.getByRole("button", { name: "Install selected", exact: true })).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    await page.screenshot({ path: `${SHOTS}/bundle-confirm.png`, fullPage: false });
    await page.getByRole("button", { name: "Install selected", exact: true }).click();
    await expect(seo.getByText("Already installed")).toBeVisible();
    // Only the ticked skill installed: the catalogue agrees, the others stay available.
    const cat = await page.request.get("/api/store");
    const items = ((await cat.json()) as { items: Array<{ kind: string; key: string; installed: boolean }> }).items;
    expect(items.find((i) => i.kind === "skill" && i.key === "rank-report")?.installed).toBe(true);
    expect(items.find((i) => i.kind === "skill" && i.key === "seo-audit")?.installed).toBe(false);
    await page.screenshot({ path: `${SHOTS}/bundle-installed.png`, fullPage: false });

    // Route contract.
    const noConfirm = await page.request.post("/api/store/bundles/seo-growth/install", { data: { members: ["skill:seo-audit"] } });
    expect(noConfirm.status(), "unconfirmed install is refused").toBe(400);
    const foreign = await page.request.post("/api/store/bundles/seo-growth/install", { data: { confirmed: true, members: ["skill:brand-kit"] } });
    expect(foreign.status(), "member outside the bundle is refused").toBe(400);
    const conn = await page.request.post("/api/store/bundles/seo-growth/install", { data: { confirmed: true, members: ["connector:google-search-console"] } });
    expect(conn.status()).toBe(200);
    const connBody = (await conn.json()) as { results: Array<{ id: string; outcome: string }> };
    expect(connBody.results).toEqual([expect.objectContaining({ id: "connector:google-search-console", outcome: "skipped" })]);
    const unknown = await page.request.post("/api/store/bundles/nope/install", { data: { confirmed: true, members: ["skill:seo-audit"] } });
    expect(unknown.status()).toBe(404);

    // Signed out: no listing and no install.
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    expect((await page.request.get("/api/store/bundles")).status(), "control: logged-in is authenticated").toBe(200);
    expect((await anon.request.get("/api/store/bundles")).status(), "control: fresh context is unauthenticated").toBe(401);
    expect((await anon.request.post("/api/store/bundles/seo-growth/install", { data: { confirmed: true, members: ["skill:seo-audit"] } })).status()).toBe(401);
    await anon.close();

    // Restore the shared e2e workspace.
    const rm = await page.request.post("/api/store/items", { data: { action: "remove", kind: "skill", key: "rank-report" } });
    expect(rm.status()).toBe(200);
  });
});
