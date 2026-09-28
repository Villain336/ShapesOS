// Marketr — Knowledge Brain: morph-form geometry tests.
// Run: npx tsx --test lib/intelligence/corpus/__tests__/brain-morph-forms.test.ts
//
// Only the pure data mapping is tested here (shape count, alignment,
// normalization bounds, determinism). WebGL rendering is verified via
// screenshots, not unit tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMorphForms,
  MORPH_SHAPES,
  MORPH_SHAPE_LABELS,
} from "../brain-morph-forms";

const CENTER: [number, number, number] = [0, -0.2, 0.4];
const SCALE = 5.5;

describe("buildMorphForms", () => {
  it("builds one index-aligned field per shape", () => {
    const count = 200;
    const forms = buildMorphForms(count, SCALE, CENTER);
    assert.equal(forms.length, MORPH_SHAPES.length);
    assert.equal(MORPH_SHAPES.length, 6);
    for (const f of forms) {
      assert.equal(f.length, count * 3);
    }
  });

  it("normalizes every shape into the scaled bounding box around the center", () => {
    const count = 500;
    const forms = buildMorphForms(count, SCALE, CENTER);
    for (const f of forms) {
      for (let i = 0; i < count * 3; i++) {
        const axis = i % 3;
        const v = f[i] - CENTER[axis];
        // ±0.95 normalized, scaled; allow a hair of float slack.
        assert.ok(
          Math.abs(v) <= SCALE * 0.96,
          `out of bounds: |${v}| > ${SCALE * 0.96}`,
        );
      }
    }
  });

  it("is deterministic across calls", () => {
    const a = buildMorphForms(120, SCALE, CENTER);
    const b = buildMorphForms(120, SCALE, CENTER);
    for (let s = 0; s < a.length; s++) {
      assert.deepEqual(a[s], b[s]);
    }
  });

  it("labels every shape", () => {
    for (const name of MORPH_SHAPES) {
      assert.ok(
        MORPH_SHAPE_LABELS[name] && MORPH_SHAPE_LABELS[name].length > 0,
        `missing label for ${name}`,
      );
    }
  });

  it("handles a single particle without NaN", () => {
    const forms = buildMorphForms(1, SCALE, CENTER);
    for (const f of forms) {
      assert.equal(f.length, 3);
      for (const v of f) assert.ok(Number.isFinite(v), `non-finite value ${v}`);
    }
  });
});
