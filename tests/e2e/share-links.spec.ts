// ShapesOS — share links beyond Studio (Phase 23; pixel evidence).
//
// An Office doc gets an expiring, revocable read-only share link from its
// toolbar; the public page renders the doc for anyone with the link, no
// sign-in, and 404s once revoked. PNGs land in test-results/share-links/.

import { expect, test } from "@playwright/test";
import { gotoClean, loadIds } from "./helpers";

const SHOTS = "test-results/share-links";

test.describe("share links beyond Studio", () => {
  test("an Office doc shares by token link; the public page is read-only and dies on revoke", async ({ page, browser }) => {
    loadIds();
    // Draft a doc through the real API (editor session from storageState).
    const create = await page.request.post("/api/office/docs", {
      data: { kind: "doc", title: "Share-gate pixel doc", snapshot: { body: { textRuns: [{ st: 0, ed: 5, ts: {} }] } } },
    });
    expect(create.status(), "doc created").toBe(201);
    const { doc } = (await create.json()) as { doc: { id: string } };

    // The share panel on the doc's toolbar.
    await gotoClean(page, `/dashboard/office?open=${doc.id}`);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(page.getByText("Share links")).toBeVisible();
    await expect(page.getByText(/No share links yet/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/office-share-panel.png` });

    // Mint a link through the API (the UI path is the same endpoint, behind
    // an explicit confirmation).
    const mint = await page.request.post(`/api/office/docs/${doc.id}/shares`, {
      data: { label: "e2e pixel", expiresInDays: 1 },
    });
    expect(mint.status(), "link minted").toBe(201);
    const { token } = (await mint.json()) as { token: string };

    // The public page: a fresh, signed-out context sees the read-only doc.
    const anon = await browser.newContext();
    const pub = await anon.newPage();
    const res = await pub.goto(`/o/${token}`, { waitUntil: "domcontentloaded" });
    expect(res!.status(), "public page 200").toBe(200);
    await expect(pub.getByRole("heading", { name: "Share-gate pixel doc" })).toBeVisible();
    await expect(pub.getByText(/shared read-only/)).toBeVisible();
    await pub.screenshot({ path: `${SHOTS}/public-doc.png`, fullPage: false });
    // No save affordance on the public page.
    await expect(pub.getByRole("button", { name: /Save to ShapesOS/ })).toHaveCount(0);

    // Revoke: the public page 404s immediately.
    const shares = await page.request.get(`/api/office/docs/${doc.id}/shares`);
    const shareId = ((await shares.json()) as { shares: { id: string }[] }).shares[0]!.id;
    const del = await page.request.delete(`/api/office/docs/${doc.id}/shares/${shareId}`);
    expect(del.status()).toBe(200);
    const gone = await pub.goto(`/o/${token}`, { waitUntil: "domcontentloaded" });
    expect(gone!.status(), "revoked link 404s").toBe(404);
    await anon.close();
  });
});
