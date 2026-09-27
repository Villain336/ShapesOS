// Marketr — Phase 11 "Canvas": curated template pack registry tests.
// Run: npx tsx --test lib/design/__tests__/template-pack.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PACK_TEMPLATES } from "../template-pack";
import { ALL_TEMPLATES } from "../templates";
import { validateDesignDocument } from "../validate";

describe("PACK_TEMPLATES", () => {
  it("loads the generated pack", () => {
    assert.ok(PACK_TEMPLATES.length >= 200, `expected 200+, got ${PACK_TEMPLATES.length}`);
    const keys = PACK_TEMPLATES.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length, "pack keys unique");
  });

  it("every pack template builds a schema-valid document with fresh ids", () => {
    for (const t of PACK_TEMPLATES) {
      const doc = t.build();
      const res = validateDesignDocument(doc);
      assert.equal(res.ok, true, `${t.key}: ${(res as { error?: string }).error ?? ""}`);
      assert.equal(doc.pages[0]!.width, t.width, `${t.key}: page width`);
      assert.equal(doc.pages[0]!.height, t.height, `${t.key}: page height`);
      const doc2 = t.build();
      const ids1 = new Set(doc.pages.flatMap((p) => p.elements.map((e) => e.id)));
      const ids2 = new Set(doc2.pages.flatMap((p) => p.elements.map((e) => e.id)));
      for (const id of ids1) assert.ok(!ids2.has(id), `${t.key}: ids not fresh`);
    }
  });

  it("ALL_TEMPLATES merges hand-built starters with the pack", () => {
    assert.equal(ALL_TEMPLATES.length, 10 + PACK_TEMPLATES.length);
    const keys = ALL_TEMPLATES.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length, "merged keys unique");
  });
});
