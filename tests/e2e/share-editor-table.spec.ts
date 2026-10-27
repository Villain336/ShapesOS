// ShapesOS - real-editor interoperability for shared tables (PR68).
//
// Drives the app's actual Univer doc editor (not a hand-built snapshot): type
// text, insert a table through the toolbar, save through the app's own Save
// button, then read the stored snapshot back and share it. The stored snapshot
// is written to test-results/share-editor/ so it can be reviewed as a fixture.
// Diagnostics (toolbar markup, screenshots) are written on every run.

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { gotoClean, loadIds } from "./helpers";

const OUT = "test-results/share-editor";

test.describe("share links with real editor output", () => {
  test.describe.configure({ timeout: 120_000 });
  test("a table inserted in the real editor saves, shares and renders", async ({ page, browser }) => {
    loadIds();
    mkdirSync(OUT, { recursive: true });
    const create = await page.request.post("/api/office/docs", { data: { kind: "doc", title: "Editor table doc" } });
    expect(create.status()).toBe(201);
    const { doc } = (await create.json()) as { doc: { id: string } };

    await gotoClean(page, `/dashboard/office?open=${doc.id}`);
    const save = page.getByRole("button", { name: /Save to ShapesOS/ });
    await expect(save).toBeEnabled({ timeout: 60_000 });
    await page.waitForTimeout(1500); // let the canvas finish its first render
    await page.screenshot({ path: `${OUT}/01-editor-open.png` });
    writeFileSync(
      `${OUT}/toolbar-buttons.txt`,
      (
        await page.evaluate(() =>
          [...document.querySelectorAll("button,[role=button],[data-u-command],[class*=toolbar] *")]
            .filter((e) => e.children.length === 0 || e.tagName === "BUTTON")
            .slice(0, 400)
            .map((e) => `${e.tagName} cmd=${e.getAttribute("data-u-command")} aria=${e.getAttribute("aria-label")} title=${e.getAttribute("title")} text=${(e.textContent || "").trim().slice(0, 30)}`)
            .join("\n"),
        )
      ),
    );

    // Type into the real editor canvas.
    const canvas = page.locator(".univer-doc-container canvas, canvas").first();
    await canvas.click({ position: { x: 200, y: 120 } });
    await page.keyboard.type("Editor table test");
    await page.keyboard.press("Enter");

    // The ribbon has Start / Insert tabs; table controls live under Insert.
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/01b-insert-tab.png` });
    writeFileSync(
      `${OUT}/insert-tab-buttons.txt`,
      await page.evaluate(() =>
        [...document.querySelectorAll("button,[role=button],[data-u-command]")]
          .map((e) => `${e.tagName} cmd=${e.getAttribute("data-u-command")} aria=${e.getAttribute("aria-label")} text=${(e.textContent || "").trim().slice(0, 30)}`)
          .filter((l) => !/Pin |Collapse/.test(l))
          .join("\n"),
      ),
    );
    // Insert a table through the toolbar.
    const tableBtn = page
      .locator('[data-u-command*="able" i], [aria-label*="table" i], [title*="table" i]')
      .first();
    await expect(tableBtn, "toolbar has a table control (see toolbar-buttons.txt)").toBeVisible({ timeout: 10_000 });
    await tableBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/02-table-menu.png` });
    const insert = page.getByText(/Insert Table/i).first();
    if (await insert.isVisible().catch(() => false)) await insert.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/03-after-insert-click.png` });
    // Some builds show a row/column grid: take the first confirm-ish control.
    const ok = page.getByRole("button", { name: /^(OK|Confirm|Insert)$/i }).first();
    if (await ok.isVisible().catch(() => false)) await ok.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/04-table-in-editor.png` });

    await save.click();
    await expect(save).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(1000);

    const got = await page.request.get(`/api/office/docs/${doc.id}`);
    expect(got.status()).toBe(200);
    const body = (await got.json()) as { doc: { snapshot: any } };
    writeFileSync(`${OUT}/editor-snapshot.json`, JSON.stringify(body.doc.snapshot, null, 2));
    const snap = body.doc.snapshot;
    expect(Array.isArray(snap?.body?.tables) && snap.body.tables.length, "editor snapshot has a table").toBeGreaterThan(0);

    const mint = await page.request.post(`/api/office/docs/${doc.id}/shares`, { data: { label: "e2e editor table", expiresInDays: 1 } });
    writeFileSync(`${OUT}/share-response.txt`, `${mint.status()} ${await mint.text()}`.replace(/osh_[A-Za-z0-9_-]+/g, "osh_REDACTED"));
    expect(mint.status(), "real editor table shares (reason in share-response.txt)").toBe(201);
    const { token } = (await mint.json()) as { token: string };
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const pub = await anon.newPage();
    expect((await pub.goto(`/o/${token}`, { waitUntil: "domcontentloaded" }))!.status()).toBe(200);
    await expect(pub.locator("article [data-shared-table]")).toHaveCount(1);
    await pub.locator("article").screenshot({ path: `${OUT}/05-public-editor-table.png` });
    await anon.close();
  });
});
