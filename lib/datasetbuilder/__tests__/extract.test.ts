// Marketr — Dataset Builder slice 1 tests: upload extraction.
// Run: npx tsx --test lib/datasetbuilder/__tests__/extract.test.ts
//
// Fixtures are built in-test (a minimal FlateDecode PDF, a DOCX zipped with
// adm-zip) so the extractor is proven against real byte layouts, not strings.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import AdmZip from "adm-zip";

import { extractTextFromUpload, kindForFilename } from "../extract";
import { DatasetBuilderError } from "../types";

function makePdf(lines: string[]): Uint8Array {
  const ops = lines.map((l) => `(${l}) Tj`).join("\n") + "\n";
  const deflated = deflateSync(Buffer.from(ops, "latin1"));
  const head = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Length " +
      deflated.length +
      " /Filter /FlateDecode >>\nstream\n",
    "latin1",
  );
  const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n", "latin1");
  return new Uint8Array(Buffer.concat([head, deflated, tail]));
}

function makeDocx(paragraphs: string[]): Uint8Array {
  const zip = new AdmZip();
  const body = paragraphs
    .map(
      (p) =>
        `<w:p><w:r><w:t>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`,
    )
    .join("");
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body>${body}</w:body></w:document>`,
      "utf8",
    ),
  );
  return new Uint8Array(zip.toBuffer());
}

describe("kindForFilename", () => {
  it("maps supported extensions", () => {
    assert.equal(kindForFilename("brief.PDF"), "pdf");
    assert.equal(kindForFilename("plan.docx"), "docx");
    assert.equal(kindForFilename("catalog.csv"), "csv");
    assert.equal(kindForFilename("notes.markdown"), "md");
  });

  it("rejects unsupported types", () => {
    assert.throws(
      () => kindForFilename("photo.png"),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "UNSUPPORTED_FILE_TYPE",
    );
  });
});

describe("extractTextFromUpload — PDF", () => {
  it("extracts Tj text from a FlateDecode stream", () => {
    const out = extractTextFromUpload(
      "one-pager.pdf",
      makePdf(["Acme pricing one-pager", "Plans start at $29 per seat"]),
    );
    assert.equal(out.kind, "pdf");
    assert.ok(out.text.includes("Acme pricing one-pager"));
    assert.ok(out.text.includes("Plans start at $29 per seat"));
    assert.equal(out.mimeType, "application/pdf");
  });

  it("rejects non-PDF bytes", () => {
    assert.throws(
      () => extractTextFromUpload("fake.pdf", new TextEncoder().encode("not a pdf")),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "EXTRACTION_FAILED",
    );
  });

  it("rejects PDFs with no extractable text", () => {
    assert.throws(
      () => extractTextFromUpload("empty.pdf", makePdf([])),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "EXTRACTION_FAILED",
    );
  });
});

describe("extractTextFromUpload — DOCX", () => {
  it("extracts paragraph text from word/document.xml", () => {
    const out = extractTextFromUpload(
      "sop.docx",
      makeDocx(["Standard operating procedure", "Step one: open the shop."]),
    );
    assert.equal(out.kind, "docx");
    assert.ok(out.text.includes("Standard operating procedure"));
    assert.ok(out.text.includes("Step one: open the shop."));
  });

  it("rejects zips that are not DOCX", () => {
    const zip = new AdmZip();
    zip.addFile("hello.txt", Buffer.from("hi", "utf8"));
    assert.throws(
      () =>
        extractTextFromUpload("fake.docx", new Uint8Array(zip.toBuffer())),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "EXTRACTION_FAILED",
    );
  });
});

describe("extractTextFromUpload — CSV", () => {
  it("turns rows into labeled lines", () => {
    const csv = 'name,price\n"Widget, Pro",29\nGadget,49\n';
    const out = extractTextFromUpload(
      "catalog.csv",
      new TextEncoder().encode(csv),
    );
    assert.equal(out.kind, "csv");
    assert.ok(out.text.includes("name: Widget, Pro | price: 29"));
    assert.ok(out.text.includes("name: Gadget | price: 49"));
  });

  it("rejects empty CSV", () => {
    assert.throws(
      () => extractTextFromUpload("empty.csv", new TextEncoder().encode("")),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "EXTRACTION_FAILED",
    );
  });
});

describe("extractTextFromUpload — MD", () => {
  it("strips frontmatter and keeps the body plus title", () => {
    const md = "---\ntitle: x\n---\n\n# Company facts\n\nWe ship worldwide.\n";
    const out = extractTextFromUpload("facts.md", new TextEncoder().encode(md));
    assert.equal(out.kind, "md");
    assert.ok(!out.text.includes("title: x"));
    assert.ok(out.text.includes("We ship worldwide."));
    assert.equal(out.title, "Company facts");
  });

  it("rejects empty markdown", () => {
    assert.throws(
      () => extractTextFromUpload("empty.md", new TextEncoder().encode("  \n")),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "EXTRACTION_FAILED",
    );
  });
});
