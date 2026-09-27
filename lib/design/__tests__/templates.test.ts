// Marketr — Phase 11 "Canvas": template library tests.
// Run: npx tsx --test lib/design/__tests__/templates.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TEMPLATES, getTemplate } from "../templates";
import { DESIGN_SCHEMA_VERSION, type DesignDocument } from "../types";

function validate(doc: DesignDocument, width: number, height: number) {
  assert.equal(doc.schemaVersion, DESIGN_SCHEMA_VERSION);
  assert.ok(doc.pages.length >= 1, "at least one page");
  for (const page of doc.pages) {
    assert.equal(page.width, width);
    assert.equal(page.height, height);
    assert.ok(page.elements.length >= 3, "at least 3 starter elements");
    const ids = page.elements.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "element ids unique");
    for (const el of page.elements) {
      assert.ok(el.id.length > 0);
      assert.ok(el.name.length > 0);
      assert.ok(Number.isFinite(el.x) && Number.isFinite(el.y));
    }
  }
}

describe("TEMPLATES", () => {
  it("exports exactly 10 templates", () => {
    assert.equal(TEMPLATES.length, 10);
  });

  it("template keys are unique", () => {
    const keys = TEMPLATES.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  for (const t of TEMPLATES) {
    it(`builds a valid doc: ${t.key} (${t.width}x${t.height})`, () => {
      validate(t.build(), t.width, t.height);
    });
  }

  it("every template has name, category, and description", () => {
    for (const t of TEMPLATES) {
      assert.ok(t.name.length > 0);
      assert.ok(
        ["social", "ads", "web", "print"].includes(t.category),
        `valid category for ${t.key}`,
      );
      assert.ok(t.description.length > 0);
    }
  });

  it("copy is real placeholder text, never lorem ipsum", () => {
    for (const t of TEMPLATES) {
      const doc = t.build();
      const texts = doc.pages.flatMap((p) =>
        p.elements.filter((e) => e.type === "text").map((e) => e.text),
      );
      assert.ok(texts.length >= 3, `${t.key}: headline + subtext + CTA`);
      for (const text of texts) {
        assert.ok(!/lorem/i.test(text), `${t.key}: no lorem ipsum`);
        assert.ok(text.trim().length > 0);
      }
    }
  });

  it("CTA pills pair a rect with a centered label", () => {
    for (const t of TEMPLATES) {
      const els = t.build().pages[0]!.elements;
      const pill = els.find((e) => e.name === "CTA pill");
      const label = els.find((e) => e.name === "CTA label");
      assert.ok(pill && pill.type === "rect", `${t.key}: CTA pill rect`);
      assert.ok(label && label.type === "text", `${t.key}: CTA label text`);
      assert.equal((pill as { fill: string }).fill, "#7c3aed");
    }
  });
});

describe("getTemplate", () => {
  it("returns the template for a known key", () => {
    const t = getTemplate("instagram-post");
    assert.ok(t);
    assert.equal(t!.width, 1080);
    assert.equal(t!.height, 1080);
  });

  it("returns undefined for an unknown key", () => {
    assert.equal(getTemplate("does-not-exist"), undefined);
  });
});
