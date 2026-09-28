// Phase 14 slice 8 — in-house export + report-template doc flow.
// Exercises: CSV quoting/sparse grids, PDF structure (header/xref/brand),
// tiptap → doc snapshot mapping, and the from-report-template round trip.
// Run: npx tsx scripts/verify-phase14-univer-export.mts

import { randomUUID } from "node:crypto";
import { buildDocSnapshot, buildSheetSnapshot, validateSnapshot } from "../lib/univer/snapshots";
import { docSnapshotToParagraphs, exportDocPdf, exportSheetCsv, slugifyFilename } from "../lib/univer/export";
import { tiptapToDocSnapshot, tiptapToParagraphs } from "../lib/univer/tiptap";
import { createUniverDoc } from "../lib/univer/docs";
import { prisma } from "../lib/prisma";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n## CSV export");
{
  const snap = buildSheetSnapshot({
    title: "Q",
    headers: ["Name", "Note", "N"],
    rows: [
      ["Alice", "says, hi", 1],
      ["Bob", 'quote "x"\nnewline', 2.5],
      ["", "", ""],
    ],
  });
  const csv = exportSheetCsv(snap);
  check("header row", csv.startsWith("Name,Note,N\r\n"), JSON.stringify(csv.slice(0, 40)));
  check("comma quoted", csv.includes('"says, hi"'));
  check("quote doubled + newline quoted", csv.includes('"quote ""x""\nnewline"'));
  check("trailing empty row trimmed", !csv.endsWith(",\r\n,\r\n"));
  check("empty sheet → empty csv", exportSheetCsv(buildSheetSnapshot({ title: "E", headers: [], rows: [] })) === "");
}

console.log("\n## tiptap → doc snapshot");
{
  const tiptap = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Monthly SEO Report" }] },
      { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world", marks: [{ type: "bold" }] }] },
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
      ]},
      { type: "paragraph", content: [{ type: "text", text: "{{rankings_table}}" }] },
    ],
  };
  const paras = tiptapToParagraphs(tiptap);
  check("4 paragraphs (heading + para + 2 items + para)", paras.length === 5, String(paras.length));
  check("heading level mapped", paras[0].headingLevel === 1);
  check("bold mark mapped", paras[1].runs.some((r) => r.bold && r.text === "world"));
  check("bullet prefix", paras[2].runs[0].text === "• ");
  const snap = tiptapToDocSnapshot(tiptap, "Report");
  check("doc snapshot validates", validateSnapshot("doc", snap).ok);
  const stream = (snap.body?.dataStream ?? "") as string;
  check("template tokens preserved", stream.includes("{{rankings_table}}"));
  check("invalid tiptap → blank-ish doc", validateSnapshot("doc", tiptapToDocSnapshot(null, "X")).ok);
}

console.log("\n## PDF export");
{
  const snap = buildDocSnapshot({
    title: "PDF Test",
    paragraphs: [
      { text: "Executive summary", headingLevel: 1 },
      { text: "This is a fairly long body paragraph that should wrap across multiple lines in the rendered PDF so pagination and wrapping can be observed.", boldRanges: [[10, 16]] },
      { text: "Second section", headingLevel: 2 },
      ...Array.from({ length: 60 }, (_, i) => ({ text: `Filler line number ${i + 1} with some words to force multiple pages.`, boldRanges: [] as Array<[number, number]> })),
    ],
  });
  const pdf = exportDocPdf(snap, { title: "PDF Test", brandName: "Acme Co" });
  const head = new TextDecoder().decode(pdf.slice(0, 8));
  check("PDF magic header", head.startsWith("%PDF-1.4"), head);
  const tail = new TextDecoder().decode(pdf.slice(-20));
  check("EOF marker", tail.includes("%%EOF"));
  const text = new TextDecoder("latin1").decode(pdf);
  check("brand name in header", text.includes("Acme Co"));
  check("title in header", text.includes("PDF Test"));
  check("page numbers in footer", text.includes("Page 1 of"));
  const pageCount = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
  check("multi-page (long doc)", pageCount > 1, `${pageCount} pages`);
  check("xref offsets present", text.includes("xref") && text.includes("startxref"));
}

console.log("\n## filename slugs");
{
  check("slug", slugifyFilename("Q3 Report — Acme!", "pdf") === "q3-report-acme.pdf", slugifyFilename("Q3 Report — Acme!", "pdf"));
  check("fallback", slugifyFilename("!!!", "csv") === "export.csv");
}

console.log("\n## from-report-template round trip");
{
  const id = `test-${randomUUID()}`;
  await prisma.univerDoc.deleteMany({ where: { workspaceId: id } });
  await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id, name: "slice8-test", ownerUserId: "slice8-owner" } });
  try {
    const tiptap = { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "T" }] }] };
    const snap = tiptapToDocSnapshot(tiptap, "Monthly SEO Report");
    const doc = await createUniverDoc(id, { kind: "doc", title: "Monthly SEO Report (doc)", snapshot: snap, sourceRef: "report-template:abc" });
    check("doc stored with sourceRef", (doc as { sourceRef?: string }).sourceRef === "report-template:abc");
    const paras = docSnapshotToParagraphs(doc.snapshot as never);
    check("stored doc re-extracts paragraphs", paras.length >= 1 && paras[0].headingLevel === 1);
  } finally {
    await prisma.univerDoc.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.deleteMany({ where: { id } });
  }
}

await prisma.$disconnect();

console.log(`\n${pass}/${pass + fail} checks passed`);
if (failures.length) { console.log("FAILURES:", failures.join(", ")); process.exit(1); }
