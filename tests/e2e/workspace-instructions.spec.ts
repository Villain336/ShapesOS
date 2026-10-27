// ShapesOS - shared workspace instructions (Phase 25; route + pixel evidence).
// Admin saves text, it persists across a reload, a stale save is refused with
// 409, the history lists the revision, and signed-out callers get 401.
// PNGs land in test-results/workspace-instructions/.

import { expect, test } from "@playwright/test";
import { gotoClean } from "./helpers";

test.describe("workspace instructions", () => {
  test("admin saves, it persists, stale saves are refused, signed-out is refused", async ({ page, browser }) => {
    await gotoClean(page, "/dashboard/settings/instructions");
    const box = page.getByLabel("Instructions for agents");
    await expect(box).toBeVisible();
    const before = await (await page.request.get("/api/settings/instructions")).json();
    expect(before.canEdit).toBe(true);
    const text = `E2E guidance ${Date.now()}: cite the source page for every claim.`;
    await box.fill(text);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved. New agent turns include this text.")).toBeVisible();
    await expect(page.getByTestId("instructions-meta")).toContainText(`Revision ${before.instructions.revision + 1}`);

    await page.reload();
    await expect(page.getByLabel("Instructions for agents")).toHaveValue(text);
    await expect(page.getByText(/it is guidance/).first()).toBeVisible();
    await page.screenshot({ path: "test-results/workspace-instructions/saved.png", fullPage: false });

    // Stale save: the revision the editor saw is no longer current.
    const stale = await page.request.put("/api/settings/instructions", { data: { body: "stale", expectedRevision: before.instructions.revision } });
    expect(stale.status()).toBe(409);
    const after = await (await page.request.get("/api/settings/instructions")).json();
    expect(after.instructions.body).toBe(text);
    expect(after.revisions[0].revision).toBe(before.instructions.revision + 1);

    // Over-length text is a 400.
    const long = await page.request.put("/api/settings/instructions", { data: { body: "x".repeat(4001), expectedRevision: after.instructions.revision } });
    expect(long.status()).toBe(400);

    // Signed out (explicit empty storageState + a logged-in control).
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    expect((await page.request.get("/api/settings/instructions")).status(), "control: logged-in is authenticated").toBe(200);
    expect((await anon.request.get("/api/settings/instructions")).status(), "control: fresh context is unauthenticated").toBe(401);
    expect((await anon.request.put("/api/settings/instructions", { data: { body: "x", expectedRevision: 0 } })).status()).toBe(401);
    await anon.close();

    // Leave the shared e2e workspace without instructions.
    const clear = await page.request.put("/api/settings/instructions", { data: { body: "", expectedRevision: after.instructions.revision } });
    expect(clear.status()).toBe(200);
  });
});
