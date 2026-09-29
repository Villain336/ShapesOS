// Marketr — Phase 16 slice 9: template lint tests.
// Run: npx tsx --test lib/reports/__tests__/template-lint.test.ts
//
// Proves the WeasyPrint gotcha is caught: CSS Images Level 4 double-position
// color stops (the silent whole-background drop found in the proof) FAIL the
// template, while single-position stops pass.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lintTemplateCss, assertTemplateCssValid } from "@/lib/reports/template-lint";

const CLEAN = `
.hero {
  background:
    repeating-linear-gradient(115deg,
      rgba(255,255,255,0) 0,
      rgba(255,255,255,0.035) 22px,
      rgba(255,255,255,0) 24px),
    linear-gradient(120deg, #2e1065 0%, #6d28d9 55%, #7c3aed 100%);
}
`;

const DOUBLE_POSITION = `
.hero {
  background:
    repeating-linear-gradient(115deg,
      rgba(255,255,255,0) 0,
      rgba(255,255,255,0.035) 0 22px,
      rgba(255,255,255,0) 24px),
    linear-gradient(120deg, #2e1065 0%, #6d28d9 55%, #7c3aed 100%);
}
`;

describe("template lint — double-position color stops", () => {
  it("passes clean single-position CSS", () => {
    assert.deepEqual(lintTemplateCss(CLEAN), []);
    assertTemplateCssValid(CLEAN, "test@1.0.0"); // no throw
  });

  it("rejects double-position color stops with a helpful message", () => {
    const errors = lintTemplateCss(DOUBLE_POSITION);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "double-position-color-stop");
    assert.match(errors[0].message, /WeasyPrint/);
    assert.match(errors[0].message, /single-position/);
    assert.equal(errors[0].line, 6);
  });

  it("assertTemplateCssValid throws on the trap", () => {
    assert.throws(
      () => assertTemplateCssValid(DOUBLE_POSITION, "bad@1.0.0"),
      /failed CSS lint/,
    );
  });

  it("does not flag double lengths outside gradients", () => {
    // `margin: 0 22px` is legal CSS — the lint only fires inside gradient fns.
    assert.deepEqual(lintTemplateCss(".a { margin: 0 22px; padding: 1mm 2mm; }"), []);
  });

  it("flags unbalanced braces", () => {
    const errors = lintTemplateCss(".a { color: red; ");
    assert.ok(errors.some((e) => e.code === "unbalanced-braces"));
  });
});
