// ShapesOS Phase 23: what the public viewer renders vs. refuses. No database.
// Run: npx tsx --test lib/sharing/__tests__/render-support.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessSnapshot, docToBlocks, sheetToGrids, slideToPages } from "../render-support";
import { buildDocSnapshot, buildSheetSnapshot, buildSlideSnapshot } from "../../univer/snapshots";

describe("assessSnapshot", () => {
  it("accepts snapshots the app itself builds", () => {
    assert.deepEqual(assessSnapshot("doc", buildDocSnapshot({ title: "t", paragraphs: ["a", { text: "b", boldRanges: [[0, 1]] }], heading: "H" })), { ok: true });
    assert.deepEqual(assessSnapshot("slide", buildSlideSnapshot({ title: "d", slides: [{ title: "One", body: "x\ny" }] })), { ok: true });
    assert.deepEqual(assessSnapshot("sheet", buildSheetSnapshot({ title: "s", headers: ["a"], rows: [[1]] } as never)), { ok: true });
  });
  it("refuses content it cannot render instead of dropping it", () => {
    const base = { body: { dataStream: "x\r\n", paragraphs: [{ startIndex: 0 }], textRuns: [] } };
    const bad = (extra: object, re: RegExp) => {
      const r = assessSnapshot("doc", { ...base, ...extra, body: { ...base.body, ...((extra as { body?: object }).body ?? {}) } });
      assert.equal(r.ok, false);
      assert.match((r as { reason: string }).reason, re);
    };
    bad({ body: { tables: [{ tableId: "t" }] } }, /tables/);
    bad({ drawings: { d1: {} } }, /images/);
    bad({ body: { customBlocks: [{ blockId: "b" }] } }, /embedded/);
    bad({ body: { sectionBreaks: [{ startIndex: 1 }] } }, /section/);
    bad({ body: { customRanges: [{ startIndex: 0, endIndex: 1 }] } }, /links/);
    bad({ body: { textRuns: [{ st: 0, ed: 1, ts: { mystery: 1 } }] } }, /unsupported text style/);
    assert.equal(assessSnapshot("sheet", { sheets: { s: { mergeData: [{ startRow: 0 }] } } }).ok, false);
    assert.equal(assessSnapshot("slide", { body: { pages: { p: { pageElements: { e: { type: 0 } } } } } }).ok, false);
    assert.equal(assessSnapshot("pdf", {}).ok, false);
    assert.equal(assessSnapshot("doc", null).ok, false);
  });
});

describe("renderers", () => {
  it("doc: headings, bold, italic, bullets, spacers survive", () => {
    const snap = {
      body: {
        dataStream: "Title\r\n\r\nHello world\r\nItem\r\n",
        paragraphs: [
          { startIndex: 0, paragraphStyle: { headingId: "heading1" } },
          { startIndex: 7 },
          { startIndex: 8 },
          { startIndex: 21, bullet: { listId: "l" } },
        ],
        textRuns: [{ st: 9, ed: 14, ts: { bl: 1 } }, { st: 15, ed: 20, ts: { it: 1 } }],
      },
    };
    const b = docToBlocks(snap);
    assert.equal(b.length, 4);
    assert.equal(b[0].level, 1);
    assert.equal(b[1].segs.length, 0);
    assert.deepEqual(b[2].segs.map((s) => [s.text, s.bold, s.italic]), [["Hello", true, false], [" ", false, false], ["world", false, true]].slice(0, 3).map((x) => x));
    assert.equal(b[3].bullet, true);
  });
  it("sheet: grid by order, values kept", () => {
    const g = sheetToGrids({ sheetOrder: ["b", "a"], sheets: { a: { name: "A", cellData: { 0: { 0: { v: 1 } } } }, b: { name: "B", cellData: { 1: { 1: { v: "x" } } } } } });
    assert.deepEqual(g.map((s) => s.name), ["B", "A"]);
    assert.deepEqual(g[0].rows, [["", ""], ["", "x"]]);
    assert.deepEqual(g[1].rows, [["1"]]);
  });
  it("slide: pages in order with title and body elements", () => {
    const p = slideToPages(buildSlideSnapshot({ title: "d", slides: [{ title: "One", body: "a\nb" }, { title: "Two" }] }));
    assert.equal(p.length, 2);
    assert.equal(p[0].title, "One");
    assert.equal(p[0].elements.length, 2);
    assert.equal(p[0].elements[1].map((x) => x.segs.map((s) => s.text).join("")).join("|"), "a|b");
  });
});
