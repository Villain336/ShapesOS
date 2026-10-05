// ShapesOS Phase 11 (seotools): DOCX / XLSX writers, the markdown-ish block
// parser, Univer DOCX/XLSX export and the document tools' argument parsing.
// Files are opened back up (DOCX: the zip's word/document.xml; XLSX: exceljs)
// to check what was written. No database.
// Run: npx tsx --test lib/documents/__tests__/documents.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { coerceDocBlocks, markdownToDocBlocks, parseInline, plainText } from "../blocks";
import { buildDocx } from "../docx";
import { buildXlsx, readXlsx, safeSheetName } from "../xlsx";
import { inferCell, parseSheetArgs } from "../tools";
import { docSnapshotToBlocks, exportDocDocx, exportSheetXlsx, sheetSnapshotToSheets } from "@/lib/univer/export";

async function documentXml(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return zip.file("word/document.xml")!.async("string");
}

describe("parseInline", () => {
  it("splits bold, italic, code and safe links", () => {
    assert.deepEqual(parseInline("A **b** _c_ *d* `e` [f](https://x.example)"), [
      { text: "A " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", italic: true },
      { text: " " },
      { text: "e", code: true },
      { text: " " },
      { text: "f", link: "https://x.example" },
    ]);
    // Unsafe schemes keep the label as plain text, never a link.
    assert.ok(!parseInline("[g](javascript:alert)").some((r) => r.link));
    assert.equal(plainText("**Bold** and [link](https://a.example)"), "Bold and link");
    assert.deepEqual(parseInline("snake_case_word"), [{ text: "snake_case_word" }]);
  });
});

describe("markdownToDocBlocks", () => {
  it("parses headings, lists, quotes, fences, tables, rules and breaks", () => {
    const md = [
      "# Report",
      "Intro line one",
      "line two",
      "",
      "## Findings ##",
      "- top",
      "  - nested",
      "1. first",
      "2) second",
      "> quoted",
      "> more",
      "```",
      "const x = 1;",
      "```",
      "| Name | Value |",
      "|---|:---:|",
      "| a \\| b | 1 |",
      "---",
      "<!-- pagebreak -->",
      "#### Deep",
    ].join("\n");
    assert.deepEqual(markdownToDocBlocks(md), [
      { type: "heading", level: 1, text: "Report" },
      { type: "paragraph", text: "Intro line one line two" },
      { type: "heading", level: 2, text: "Findings" },
      { type: "bullet", text: "top", level: 0 },
      { type: "bullet", text: "nested", level: 1 },
      { type: "numbered", text: "first", level: 0 },
      { type: "numbered", text: "second", level: 0 },
      { type: "quote", text: "quoted more" },
      { type: "code", text: "const x = 1;" },
      { type: "table", rows: [["Name", "Value"], ["a | b", "1"]], header: true },
      { type: "divider" },
      { type: "pageBreak" },
      { type: "heading", level: 3, text: "Deep" },
    ]);
  });

  it("coerces JSON blocks and rejects unknown types", () => {
    assert.deepEqual(coerceDocBlocks([{ type: "heading", level: 7, text: "x" }, { type: "table", rows: [[1, null]] }]), [
      { type: "heading", level: 1, text: "x" },
      { type: "table", rows: [["1", ""]], header: true },
    ]);
    assert.throws(() => coerceDocBlocks([{ type: "video" }]), /unknown type/);
    assert.throws(() => coerceDocBlocks({}), /array/);
  });
});

describe("buildDocx", () => {
  it("writes a real .docx with title, text, list numbering, table and link", async () => {
    const buf = await buildDocx({
      title: "Quarterly report",
      blocks: markdownToDocBlocks("# Summary\nRevenue grew **12%**. See [the dashboard](https://acme.example/d).\n\n1. One\n2. Two\n\n| A | B |\n|---|---|\n| 1 | 2 |"),
    });
    assert.equal(buf.subarray(0, 2).toString(), "PK");
    const xml = await documentXml(buf);
    for (const s of ["Quarterly report", "Summary", "Revenue grew ", "12%", "the dashboard", "One", "Two", "<w:tbl>"]) assert.ok(xml.includes(s), s);
    assert.match(xml, /<w:b\/>[\s\S]*12%/);
    const zip = await JSZip.loadAsync(buf);
    assert.ok(zip.file("word/numbering.xml"));
    assert.match(await zip.file("word/_rels/document.xml.rels")!.async("string"), /https:\/\/acme.example\/d/);
    assert.match(await zip.file("docProps/core.xml")!.async("string"), /Quarterly report/);
  });

  it("handles an empty body", async () => {
    const xml = await documentXml(await buildDocx({ blocks: [] }));
    assert.match(xml, /<w:body>/);
  });
});

describe("buildXlsx", () => {
  it("keeps types, stores formula-looking text as text, names sheets safely", async () => {
    const buf = await buildXlsx({
      title: "Data",
      sheets: [
        { name: "Q1: revenue/costs", rows: [["Month", "Revenue", "Note", "Paid"], ["Jan", 1200.5, "=HYPERLINK(\"http://evil\")", true], ["Feb", 900, null, false]] },
        { name: "Q1: revenue/costs", rows: [["x"]], header: false },
      ],
    });
    const sheets = await readXlsx(buf);
    assert.deepEqual(sheets.map((s) => s.name), ["Q1  revenue costs", "Q1  revenue costs (2)"]);
    assert.deepEqual(sheets[0].rows[1], ["Jan", 1200.5, '=HYPERLINK("http://evil")', true]);
    const zip = await JSZip.loadAsync(buf);
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    assert.doesNotMatch(sheetXml, /<f>/, "no formula cells are ever written");
    assert.match(sheetXml, /<pane[^>]*ySplit="1"/);
    assert.match(sheetXml, /<autoFilter ref="A1:D3"/);
  });

  it("rejects empty workbooks and oversized rows", async () => {
    await assert.rejects(buildXlsx({ sheets: [] }), /at least one sheet/);
    await assert.rejects(buildXlsx({ sheets: [{ name: "s", rows: [new Array(501).fill(1)] }] }), /max 500/);
    const taken = new Set<string>();
    assert.equal(safeSheetName("", taken), "Sheet");
    assert.equal(safeSheetName("x".repeat(40), taken).length, 31);
  });
});

describe("document tool arguments", () => {
  it("infers CSV cell types without mangling identifiers", () => {
    assert.equal(inferCell("42"), 42);
    assert.equal(inferCell("-3.5"), -3.5);
    assert.equal(inferCell("007"), "007");
    assert.equal(inferCell("1,234"), "1,234");
    assert.equal(inferCell("TRUE"), true);
    assert.equal(inferCell(" "), null);
    assert.equal(inferCell("12345678901234567890"), "12345678901234567890");
  });

  it("accepts rows, sheets or csv", () => {
    assert.deepEqual(parseSheetArgs({ rows: '[["a","b"],[1,{"x":1}]]' }), [{ name: "Sheet1", rows: [["a", "b"], [1, '{"x":1}']], header: true }]);
    assert.deepEqual(parseSheetArgs({ csv: "zip,amount\n02134,10.5\n", sheetName: "Data" }), [{ name: "Data", rows: [["zip", "amount"], ["02134", 10.5]], header: true }]);
    assert.equal(parseSheetArgs({ sheets: [{ name: "A", rows: [["x"]] }, { rows: [] }] })[1].name, "Sheet2");
    assert.throws(() => parseSheetArgs({ rows: '[{"a":1}]' }), /arrays/);
    assert.throws(() => parseSheetArgs({}), /Pass sheets, rows or csv/);
    assert.throws(() => parseSheetArgs({ sheets: "{" }), /must be JSON/);
  });
});

describe("Univer export (DOCX / XLSX)", () => {
  const docSnapshot = {
    id: "d",
    body: {
      dataStream: "Title\rHello bold world\r\n",
      textRuns: [{ st: 12, ed: 16, ts: { bl: 1 } }],
      paragraphs: [{ startIndex: 5, paragraphStyle: { headingId: "heading1" } }, { startIndex: 22 }],
    },
  };

  it("turns a doc into blocks with exact bold runs and a .docx", async () => {
    const blocks = docSnapshotToBlocks(docSnapshot as never);
    assert.deepEqual(blocks, [
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", text: "Hello bold world", runs: [{ text: "Hello " }, { text: "bold", bold: true }, { text: " world" }] },
    ]);
    const xml = await documentXml(await exportDocDocx(docSnapshot as never, { title: "My doc" }));
    assert.ok(xml.includes("Hello ") && xml.includes("bold") && xml.includes("My doc"));
  });

  it("turns a workbook into typed sheets in sheet order and a .xlsx", async () => {
    const wb = {
      id: "w",
      sheetOrder: ["s2", "s1"],
      sheets: {
        s1: { id: "s1", name: "First", cellData: { 0: { 0: { v: "a" } } } },
        s2: { id: "s2", name: "Second", cellData: { 0: { 0: { v: "Qty" }, 2: { v: 3 } }, 1: { 1: { v: true } } } },
      },
    };
    const sheets = sheetSnapshotToSheets(wb as never);
    assert.deepEqual(sheets.map((s) => s.name), ["Second", "First"]);
    assert.deepEqual(sheets[0].rows, [["Qty", null, 3], [null, true, null]]);
    const back = await readXlsx(await exportSheetXlsx(wb as never));
    assert.deepEqual(back.map((s) => s.name), ["Second", "First"]);
    assert.equal(back[0].rows[0][2], 3);
  });
});
