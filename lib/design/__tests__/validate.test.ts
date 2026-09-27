// Marketr — Phase 11 "Canvas": design document validator tests.
// Run: npx tsx --test lib/design/__tests__/validate.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateDesignDocument, MAX_DESIGN_DOCUMENT_BYTES } from "../validate";
import { blankDocument } from "../types";

const goodPage = () => ({
  id: "page-1",
  name: "Page 1",
  width: 1080,
  height: 1080,
  background: "#ffffff",
  elements: [
    {
      id: "el-1",
      type: "text",
      name: "Headline",
      x: 10,
      y: 20,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      text: "Hello",
      fontFamily: "Inter",
      fontSize: 48,
    },
    {
      id: "el-2",
      type: "rect",
      name: "Box",
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      width: 100,
      height: 50,
      fill: "#7c3aed",
    },
    {
      id: "el-3",
      type: "line",
      name: "Rule",
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      points: [0, 0, 100, 0],
      stroke: "#000000",
      strokeWidth: 2,
    },
    {
      id: "el-4",
      type: "image",
      name: "Photo",
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      src: "https://example.com/a.png",
      width: 200,
      height: 100,
    },
    {
      id: "el-5",
      type: "ellipse",
      name: "Blob",
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      fill: "#ffffff",
    },
    {
      id: "el-6",
      type: "svg",
      name: "Icon",
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      path: "M0 0h24v24H0z",
    },
  ],
});

describe("validateDesignDocument", () => {
  it("accepts a well-formed document", () => {
    const r = validateDesignDocument({ schemaVersion: 1, pages: [goodPage()] });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.doc.pages.length, 1);
  });

  it("accepts blankDocument output", () => {
    const r = validateDesignDocument(blankDocument(1080, 1080));
    assert.equal(r.ok, true);
  });

  it("rejects a wrong schemaVersion", () => {
    const r = validateDesignDocument({ schemaVersion: 2, pages: [goodPage()] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /schemaVersion/);
  });

  it("rejects a missing/empty pages array", () => {
    const r1 = validateDesignDocument({ schemaVersion: 1, pages: [] });
    assert.equal(r1.ok, false);
    const r2 = validateDesignDocument({ schemaVersion: 1 });
    assert.equal(r2.ok, false);
  });

  it("rejects an unknown element type", () => {
    const page = goodPage();
    page.elements[0].type = "group";
    const r = validateDesignDocument({ schemaVersion: 1, pages: [page] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /type/);
  });

  it("rejects a text element missing fontSize", () => {
    const page = goodPage();
    delete (page.elements[0] as Record<string, unknown>).fontSize;
    const r = validateDesignDocument({ schemaVersion: 1, pages: [page] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /fontSize/);
  });

  it("rejects a page with non-positive dimensions", () => {
    const page = goodPage();
    page.width = 0;
    const r = validateDesignDocument({ schemaVersion: 1, pages: [page] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /width/);
  });

  it("rejects non-object inputs without throwing", () => {
    for (const bad of [null, undefined, 42, "doc", [1, 2], true]) {
      const r = validateDesignDocument(bad);
      assert.equal(r.ok, false, `expected failure for ${String(bad)}`);
    }
  });

  it("rejects documents over the 5MB serialized cap", () => {
    const page = goodPage();
    // A single long string element attribute that pushes the serialized
    // document past the cap.
    (page.elements[0] as Record<string, unknown>).text = "x".repeat(MAX_DESIGN_DOCUMENT_BYTES + 1);
    const r = validateDesignDocument({ schemaVersion: 1, pages: [page] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /exceeds/);
  });

  it("rejects circular documents without throwing", () => {
    const doc: Record<string, unknown> = { schemaVersion: 1, pages: [goodPage()] };
    doc.self = doc;
    const r = validateDesignDocument(doc);
    assert.equal(r.ok, false);
  });
});
