// ShapesOS — share links beyond Studio (Phase 23; pixel + route evidence).
//
// Office doc: share panel, public read-only page (no private metadata, no
// edit affordances), revoked + expired tokens 404. Report: a real ready
// report (seed writes its PDF through the app's own blobPut) streams inline
// over the public route with correct headers and bytes, renders in the
// browser, and dies on revoke. Unknown tokens/doc ids 404 identically
// (no oracle). PNGs land in test-results/share-links/.

import { expect, test } from "@playwright/test";
import { gotoClean, loadIds } from "./helpers";

const SHOTS = "test-results/share-links";

test.describe("share links beyond Studio", () => {
  test.describe.configure({ timeout: 90_000 }); // pdf.js mount + CI chromium headroom
  test("an Office doc shares by token link; the public page is read-only, private-clean, and dies on revoke", async ({ page, browser }) => {
    loadIds();
    const create = await page.request.post("/api/office/docs", {
      data: { kind: "doc", title: "Share-gate pixel doc" }, // no snapshot: the route builds a valid blank one
    });
    expect(create.status(), "doc created").toBe(201);
    const { doc } = (await create.json()) as { doc: { id: string } };
    // Put representative content in it: a heading, a blank spacer, body text
    // with bold + italic runs, and bullets, so the render is checked against
    // real structure and not one line.
    const lines = [
      { t: "Quarterly plan", h: "heading1" },
      { t: "" },
      { t: "Revenue grew 12% quarter over quarter.", bold: [0, 7], italic: [8, 12] },
      { t: "Ship the share links", bullet: true },
      { t: "Review the audit trail", bullet: true },
    ];
    let off = 0;
    const paragraphs: unknown[] = [];
    const textRuns: unknown[] = [];
    for (const [i, l] of lines.entries()) {
      paragraphs.push({
        startIndex: off,
        paragraphId: `p${i}`,
        ...(l.h ? { paragraphStyle: { headingId: l.h } } : {}),
        ...(l.bullet ? { bullet: { listType: "BULLET_LIST", listId: "l1", nestingLevel: 0 } } : {}),
      });
      if (l.bold) textRuns.push({ st: off + l.bold[0], ed: off + l.bold[1], ts: { bl: 1 } });
      if (l.italic) textRuns.push({ st: off + l.italic[0], ed: off + l.italic[1], ts: { it: 1 } });
      off += l.t.length + 2;
    }
    const patch = await page.request.patch(`/api/office/docs/${doc.id}`, {
      data: {
        snapshot: {
          id: "e2e-shared-doc",
          title: "Share-gate pixel doc",
          locale: "enUS",
          documentStyle: {},
          body: { dataStream: lines.map((l) => `${l.t}\r\n`).join(""), paragraphs, textRuns },
        },
      },
    });
    expect(patch.status(), "doc content saved").toBe(200);

    // Content the read-only viewer cannot show faithfully is refused, not
    // silently dropped: a doc containing a table gets no share link.
    const tbl = await page.request.post("/api/office/docs", { data: { kind: "doc", title: "Has a table" } });
    const { doc: tdoc } = (await tbl.json()) as { doc: { id: string } };
    const tpatch = await page.request.patch(`/api/office/docs/${tdoc.id}`, {
      data: {
        snapshot: {
          id: "e2e-table-doc",
          title: "Has a table",
          locale: "enUS",
          documentStyle: {},
          body: { dataStream: "cell\r\n", paragraphs: [{ startIndex: 0, paragraphId: "p0" }], textRuns: [], tables: [{ startIndex: 0, endIndex: 5, tableId: "t1" }] },
        },
      },
    });
    expect(tpatch.status(), "table doc saved").toBe(200);
    const refused = await page.request.post(`/api/office/docs/${tdoc.id}/shares`, { data: {} });
    expect(refused.status(), "unsupported content is refused").toBe(422);
    expect(((await refused.json()) as { reason: string }).reason).toMatch(/tables/);

    // Workspace boundary / no-oracle at the route level: unknown doc ids
    // are plain 404s, never a distinction between "exists elsewhere" and
    // "does not exist".
    const foreign = await page.request.post(`/api/office/docs/00000000-0000-0000-0000-000000000000/shares`, { data: {} });
    expect(foreign.status(), "unknown doc id is a 404, not an oracle").toBe(404);

    // The share panel on the doc's toolbar.
    await gotoClean(page, `/dashboard/office?open=${doc.id}`);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(page.getByText("Share links")).toBeVisible();
    await expect(page.getByText(/No share links yet/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/office-share-panel.png` });

    const mint = await page.request.post(`/api/office/docs/${doc.id}/shares`, {
      data: { label: "e2e pixel", expiresInDays: 1 },
    });
    expect(mint.status(), "link minted").toBe(201);
    const { token } = (await mint.json()) as { token: string };
    expect(token.startsWith("osh_")).toBe(true);

    // The public page: a fresh, signed-out context sees the read-only doc.
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } }); // explicitly signed out: the config storageState is otherwise inherited
    // Positive control: the same authenticated-only endpoint answers 200 for the
    // logged-in page and 401 for this context, so inherited auth state can never
    // silently turn the public-route checks below into logged-in checks.
    expect((await page.request.get(`/api/office/docs/${doc.id}/shares`)).status(), "control: logged-in context is authenticated").toBe(200);
    expect((await anon.request.get(`/api/office/docs/${doc.id}/shares`)).status(), "control: fresh context is unauthenticated").toBe(401);
    const pub = await anon.newPage();
    const res = await pub.goto(`/o/${token}`, { waitUntil: "domcontentloaded" });
    expect(res!.status(), "public page 200").toBe(200);
    await expect(pub.getByRole("heading", { name: "Share-gate pixel doc" })).toBeVisible();
    await expect(pub.getByText(/shared read-only/)).toBeVisible();
    // The populated structure renders: heading, bold + italic runs, bullets.
    await expect(pub.getByRole("heading", { name: "Quarterly plan" })).toBeVisible();
    await expect(pub.locator("article strong")).toHaveText("Revenue");
    await expect(pub.locator("article em")).toHaveText("grew");
    await expect(pub.getByText("Ship the share links")).toBeVisible();
    await expect(pub.getByText("Review the audit trail")).toBeVisible();
    expect(await pub.locator("article p").count()).toBe(3);
    // Exact text across inline nodes: whitespace at run boundaries is preserved.
    expect(await pub.locator("article p").first().innerText()).toBe("Revenue grew 12% quarter over quarter.");
    // True read-only: no editor is mounted at all - no toolbar, no
    // contenteditable/textbox/canvas, no inputs, no "edits stay local" banner.
    expect(await pub.locator('[contenteditable], textarea, input, canvas, [role="toolbar"], [role="textbox"]').count()).toBe(0);
    await expect(pub.getByText(/edits stay local/)).toHaveCount(0);
    // Typing and paste cannot change the view.
    const before = await pub.locator("article").innerText();
    await pub.locator("article").click();
    await pub.keyboard.type("INJECTED-TEXT");
    await pub.keyboard.press("Control+V");
    expect(await pub.locator("article").innerText()).toBe(before);
    expect(await pub.getByText("INJECTED-TEXT").count()).toBe(0);
    // Server write restriction: the public page has no write route; an
    // anonymous PATCH to the management API is refused.
    const anonWrite = await anon.request.patch(`/api/office/docs/${doc.id}`, { data: { title: "hijack" } });
    expect([401, 403]).toContain(anonWrite.status());
    await pub.screenshot({ path: `${SHOTS}/public-doc.png`, fullPage: false });

    // Unknown and expired tokens behave identically: plain 404.
    const nope = await pub.goto(`/o/osh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, { waitUntil: "domcontentloaded" });
    expect(nope!.status(), "unknown token 404").toBe(404);
    const { expiredDocToken } = loadIds();
    if (expiredDocToken) {
      const expired = await pub.goto(`/o/${expiredDocToken}`, { waitUntil: "domcontentloaded" });
      expect(expired!.status(), "expired token 404").toBe(404);
    }

    // Revoke: the public page 404s immediately.
    const shares = await page.request.get(`/api/office/docs/${doc.id}/shares`);
    const shareId = ((await shares.json()) as { shares: { id: string }[] }).shares[0]!.id;
    const del = await page.request.delete(`/api/office/docs/${doc.id}/shares/${shareId}`);
    expect(del.status()).toBe(200);
    const gone = await pub.goto(`/o/${token}`, { waitUntil: "domcontentloaded" });
    expect(gone!.status(), "revoked link 404s").toBe(404);
    await anon.close();
  });

  test("a ready report shares as an inline PDF over the public route; revoke kills it", async ({ page, browser }) => {
    const { reportId } = loadIds();
    expect(reportId, "seed created a ready report fixture").toBeTruthy();

    // Unknown report id: 404, no oracle.
    const foreign = await page.request.post(`/api/reports/00000000-0000-0000-0000-000000000000/shares`, { data: {} });
    expect(foreign.status(), "unknown report id is a 404").toBe(404);

    const mint = await page.request.post(`/api/reports/${reportId}/shares`, {
      data: { label: "e2e pdf", expiresInDays: 1 },
    });
    expect(mint.status(), "report link minted").toBe(201);
    const { token } = (await mint.json()) as { token: string };
    expect(token.startsWith("rsh_")).toBe(true);

    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } }); // explicitly signed out: the config storageState is otherwise inherited
    // Positive control: the same authenticated-only endpoint answers 200 for the
    // logged-in page and 401 for this context, so inherited auth state can never
    // silently turn the public-route checks below into logged-in checks.
    expect((await page.request.get(`/api/reports/${reportId}/shares`)).status(), "control: logged-in context is authenticated").toBe(200);
    expect((await anon.request.get(`/api/reports/${reportId}/shares`)).status(), "control: fresh context is unauthenticated").toBe(401);
    // Route contract: PDF bytes, inline disposition, noindex, exact length.
    const res = await anon.request.get(`/r/report/${token}/raw`);
    expect(res.status(), "public PDF bytes 200").toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect(res.headers()["content-disposition"]).toMatch(/^inline;/);
    expect(res.headers()["x-robots-tag"]).toContain("noindex");
    const body = await res.body();
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Number(res.headers()["content-length"])).toBe(body.length);

    // Rendered result: the house pdf.js viewer shows the fixture page.
    const pub = await anon.newPage();
    const pres = await pub.goto(`/r/report/${token}`, { waitUntil: "domcontentloaded" });
    expect(pres!.status(), "viewer page 200").toBe(200);
    await expect(pub.getByRole("heading", { name: "E2E Shared Report" })).toBeVisible();
    await expect(pub.getByText(/2026-10 · shared read-only/)).toBeVisible();
    await expect(pub.getByText("Page 1 of 1")).toBeVisible({ timeout: 30000 });
    await expect(pub.locator(".textLayer span").first()).toBeAttached({ timeout: 30000 });
    await pub.waitForTimeout(500); // canvas paint settle
    const rbody = (await pub.locator("body").innerText()) || "";
    expect(rbody).not.toContain("E2E Workspace");
    expect(rbody).not.toContain("e2e-admin@example.com");
    await pub.screenshot({ path: `${SHOTS}/public-report.png`, fullPage: false });

    // Unknown report token: identical 404.
    const nope = await anon.request.get(`/r/report/rsh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/raw`);
    expect(nope.status(), "unknown report token 404").toBe(404);

    // Revoke: the PDF stops streaming immediately.
    const shares = await page.request.get(`/api/reports/${reportId}/shares`);
    const shareId = ((await shares.json()) as { shares: { id: string }[] }).shares[0]!.id;
    const del = await page.request.delete(`/api/reports/${reportId}/shares/${shareId}`);
    expect(del.status()).toBe(200);
    const gone = await anon.request.get(`/r/report/${token}/raw`);
    expect(gone.status(), "revoked report bytes 404").toBe(404);
    const gonePage = await pub.goto(`/r/report/${token}`, { waitUntil: "domcontentloaded" });
    expect(gonePage!.status(), "revoked report page 404s").toBe(404);
    await anon.close();
  });

  test("links and tables render faithfully on the public page; unsafe links refuse the share", async ({ page, browser }) => {
    const LS = "\u001F", LE = "\u001E";
    const T = { TS: "\u001A", RS: "\u001B", CS: "\u001C", CE: "\u001D", RE: "\u000E", TE: "\u000F" };
    const link = (url: string) => {
      const stream = `Read ${LS}the handbook${LE} first\r\n${T.TS}${T.RS}${T.CS}Plan\r${T.CE}${T.CS}Owner\r${T.CE}${T.RE}${T.RS}${T.CS}Q4\r${T.CE}${T.CS}Tico\r${T.CE}${T.RE}${T.TE}Done\r\n`;
      return {
        id: "e2e-rich", title: "Rich share", locale: "enUS", documentStyle: {},
        body: {
          dataStream: stream,
          paragraphs: [{ startIndex: 0, paragraphId: "p0" }, {}, {}, {}, {}, {}],
          textRuns: [],
          customRanges: [{ rangeId: "r1", rangeType: 0, startIndex: stream.indexOf(LS), endIndex: stream.indexOf(LE), properties: { url } }],
          tables: [{ tableId: "t1", startIndex: stream.indexOf(T.TS), endIndex: stream.indexOf(T.TE) + 1 }],
        },
        tableSource: { t1: { tableId: "t1", tableRows: [{ tableCells: [{}, {}] }, { tableCells: [{}, {}] }] } },
      };
    };
    const make = async (title: string, url: string) => {
      const c = await page.request.post("/api/office/docs", { data: { kind: "doc", title } });
      const { doc } = (await c.json()) as { doc: { id: string } };
      const p = await page.request.patch(`/api/office/docs/${doc.id}`, { data: { snapshot: link(url) } });
      expect(p.status(), "rich doc saved").toBe(200);
      return doc.id;
    };
    const bad = await make("Unsafe link", "javascript:alert(1)");
    const refused = await page.request.post(`/api/office/docs/${bad}/shares`, { data: {} });
    expect(refused.status(), "unsafe link refuses the share").toBe(422);
    expect(((await refused.json()) as { reason: string }).reason).toMatch(/link/);

    const good = await make("Rich share", "https://example.com/handbook");
    const mint = await page.request.post(`/api/office/docs/${good}/shares`, { data: { label: "e2e rich", expiresInDays: 1 } });
    expect(mint.status(), "rich doc share minted").toBe(201);
    const { token } = (await mint.json()) as { token: string };
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const pub = await anon.newPage();
    expect((await pub.goto(`/o/${token}`, { waitUntil: "domcontentloaded" }))!.status()).toBe(200);
    const a = pub.getByRole("link", { name: "the handbook" });
    await expect(a).toHaveAttribute("href", "https://example.com/handbook");
    await expect(a).toHaveAttribute("rel", /noopener/);
    expect(await pub.locator("article p").first().innerText()).toBe("Read the handbook first");
    const cells = await pub.locator("article [data-shared-table] td").allInnerTexts();
    expect(cells.map((c) => c.trim())).toEqual(["Plan", "Owner", "Q4", "Tico"]);
    await expect(pub.getByText("Done")).toBeVisible();
    expect(await pub.locator("article").innerText()).not.toMatch(/[\u0000-\u0008\u000e-\u001f]/);
    await pub.setViewportSize({ width: 900, height: 700 });
    await pub.locator("article").screenshot({ path: `${SHOTS}/public-links-tables.png` });
    await anon.close();
  });
});
