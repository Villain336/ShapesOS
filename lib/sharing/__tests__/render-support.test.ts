// ShapesOS Phase 23: what the public viewer renders vs. refuses. No database.
// Run: npx tsx --test lib/sharing/__tests__/render-support.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessSnapshot, docToBlocks, safeHref, sheetToGrids, slideToPages } from "../render-support";
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

// ---- Links and tables (Univer 1.0.2 shapes: tokens from DataStreamTreeTokenType,
// customRanges with rangeType 0 = HYPERLINK and properties.url). Fixtures are
// hand-built from those types, NOT captured from the editor; unlike shapes fail closed.
const LS = "\u001F", LE = "\u001E";
const linkDoc = (url: unknown, extra: object = {}) => {
  const stream = `See ${LS}the docs${LE} now\r\n`;
  return {
    body: {
      dataStream: stream,
      paragraphs: [{ startIndex: 0 }],
      customRanges: [{ rangeId: "r1", rangeType: 0, startIndex: stream.indexOf(LS), endIndex: stream.indexOf(LE), properties: { url } }],
      ...extra,
    },
  };
};
describe("links", () => {
  it("renders a hyperlink as a segment with its href, sentinels removed, text intact", () => {
    const d = linkDoc("https://example.com/a?b=1");
    assert.deepEqual(assessSnapshot("doc", d), { ok: true });
    const segs = docToBlocks(d)[0].segs;
    assert.equal(segs.map((s) => s.text).join(""), "See the docs now");
    assert.deepEqual(segs.filter((s) => s.href).map((s) => [s.text, s.href]), [["the docs", "https://example.com/a?b=1"]]);
  });
  it("accepts https, http and mailto only; everything else refuses the share", () => {
    for (const ok of ["https://x.test", "http://x.test/p", "mailto:a@b.test"]) assert.equal(assessSnapshot("doc", linkDoc(ok)).ok, true, ok);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//evil.test", "/relative", "https://x.test/a b", "", undefined, 5, "vbscript:x"]) {
      const r = assessSnapshot("doc", linkDoc(bad as never));
      assert.equal(r.ok, false, String(bad));
    }
    assert.equal(safeHref("JaVaScRiPt:alert(1)"), null);
    assert.equal(safeHref("https://x.test\u0000"), null);
  });
  it("refuses internal links, non-link custom ranges, misaligned or overlapping ranges", () => {
    assert.equal(assessSnapshot("doc", linkDoc("https://x.test", { customRanges: [{ rangeId: "r", rangeType: 0, startIndex: 4, endIndex: 13, properties: { bookmarkId: "b" } }] })).ok, false);
    const d = linkDoc("https://x.test");
    (d.body.customRanges[0] as { rangeType: number }).rangeType = 3;
    assert.equal(assessSnapshot("doc", d).ok, false);
    const m = linkDoc("https://x.test");
    (m.body.customRanges[0] as { startIndex: number }).startIndex = 0;
    assert.equal(assessSnapshot("doc", m).ok, false);
    assert.equal(assessSnapshot("doc", { body: { dataStream: `a${LS}b\r\n`, paragraphs: [{ startIndex: 0 }], customRanges: [] } }).ok, false);
  });
});

const T = { TS: "\u001A", RS: "\u001B", CS: "\u001C", CE: "\u001D", RE: "\u000E", TE: "\u000F" };
const tableDoc = (extra: object = {}, tableSource: object = {}) => ({
  body: {
    dataStream: `Before\r\n${T.TS}${T.RS}${T.CS}A1\r${T.CE}${T.CS}B1\r${T.CE}${T.RE}${T.RS}${T.CS}A2\r${T.CE}${T.CS}B2\r${T.CE}${T.RE}${T.TE}After\r\n`,
    paragraphs: [{ startIndex: 0 }, {}, {}, {}, {}, {}],
    tables: [{ tableId: "t1", startIndex: 8, endIndex: 40 }],
    ...extra,
  },
  tableSource: { t1: { tableId: "t1", tableRows: [{ tableCells: [{}, {}] }, { tableCells: [{}, {}] }], ...tableSource } },
});
describe("tables", () => {
  it("renders a 2x2 table in place between paragraphs with every cell's text", () => {
    const d = tableDoc();
    assert.deepEqual(assessSnapshot("doc", d), { ok: true });
    const b = docToBlocks(d);
    assert.equal(b.length, 3);
    assert.equal(b[0].segs.map((s) => s.text).join(""), "Before");
    const rows = b[1].table!;
    assert.deepEqual(rows.map((r) => r.map((c) => c.map((x) => x.segs.map((s) => s.text).join("")).join("|"))), [["A1", "B1"], ["A2", "B2"]]);
    assert.equal(b[2].segs.map((s) => s.text).join(""), "After");
  });
  it("refuses merged cells, nested or malformed tables, tables in slides, and tables with no tokens", () => {
    const merged = tableDoc({}, { tableRows: [{ tableCells: [{ columnSpan: 2 }] }] });
    assert.equal(assessSnapshot("doc", merged).ok, false);
    const nested = tableDoc();
    nested.body.dataStream = nested.body.dataStream.replace(`A1\r`, `${T.TS}${T.RS}${T.CS}x\r${T.CE}${T.RE}${T.TE}`);
    assert.equal(assessSnapshot("doc", nested).ok, false);
    const broken = tableDoc();
    broken.body.dataStream = broken.body.dataStream.replace(T.TE, "");
    assert.equal(assessSnapshot("doc", broken).ok, false);
    assert.equal(assessSnapshot("doc", { body: { dataStream: "x\r\n", paragraphs: [{ startIndex: 0 }], tables: [{ tableId: "t" }] } }).ok, false);
    const slide = { body: { pages: { p: { pageElements: { e: { type: 2, richText: { rich: tableDoc() } } } } } } };
    assert.equal(assessSnapshot("slide", slide).ok, false);
  });
  it("still refuses what is not drawn: images, column groups, block ranges, custom blocks, stray tokens", () => {
    assert.equal(assessSnapshot("doc", { body: { dataStream: "x\r\n", paragraphs: [{ startIndex: 0 }], columnGroups: [{ columnGroupId: "c" }] } }).ok, false);
    assert.equal(assessSnapshot("doc", { body: { dataStream: "x\r\n", paragraphs: [{ startIndex: 0 }], blockRanges: [{ startIndex: 0 }] } }).ok, false);
    assert.equal(assessSnapshot("doc", { body: { dataStream: "x\b\r\n", paragraphs: [{ startIndex: 0 }] } }).ok, false);
    assert.equal(assessSnapshot("doc", { body: { dataStream: "x\u0012y\r\n", paragraphs: [{ startIndex: 0 }] } }).ok, false);
    assert.equal(assessSnapshot("doc", { drawings: { d: { drawingId: "d" } }, body: { dataStream: "x\r\n", paragraphs: [{ startIndex: 0 }] } }).ok, false);
  });
});

// REAL editor output: captured from the app's own Univer editor in CI (insert a 5x3 table via
// the toolbar, save through the Save button, read the stored snapshot back), not hand-built.
// Note the shape it taught us: every cell is "\x1c \r \n \x1d" and the "\n" is listed in
// body.sectionBreaks, which the hand-built fixtures above did not have.
import { readFileSync } from "node:fs";
describe("real editor snapshot (table)", () => {
  const snap = JSON.parse(readFileSync(new URL("./fixtures/editor-table.json", import.meta.url), "utf8"));
  it("is accepted and renders as text then a 3x5 table", () => {
    assert.deepEqual(assessSnapshot("doc", snap), { ok: true });
    const blocks = docToBlocks(snap);
    assert.equal(blocks[0].segs.map((x) => x.text).join(""), "Editor table test");
    const t = blocks.find((b) => b.table)!.table!;
    assert.equal(t.length, 3);
    assert.ok(t.every((r) => r.length === 5));
  });
  it("a section break anywhere but inside a table cell still refuses", () => {
    const bad = JSON.parse(JSON.stringify(snap));
    bad.body.sectionBreaks.push({ sectionId: "x", startIndex: 3 });
    const a = assessSnapshot("doc", bad);
    assert.equal(a.ok, false);
  });
});

