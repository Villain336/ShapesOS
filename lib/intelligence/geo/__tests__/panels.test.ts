// Marketr — Phase 10 M3: panel validation + versioning tests.
// Run: npx tsx --test lib/intelligence/geo/__tests__/panels.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validatePanelPrompts,
  nextPanelVersion,
  GEO_PANEL_MIN_PROMPTS,
  GEO_PANEL_MAX_PROMPTS,
  GeoPanelValidationError,
} from "../panels";

const dozen = Array.from({ length: 12 }, (_, i) => `Buyer prompt number ${i + 1} about crm pricing?`);

describe("validatePanelPrompts", () => {
  it("accepts a 12–25 prompt frozen panel", () => {
    const out = validatePanelPrompts(dozen);
    assert.equal(out.length, 12);
  });

  it("accepts exactly 25 prompts", () => {
    const prompts = Array.from({ length: 25 }, (_, i) => `Distinct buyer question ${i}?`);
    assert.equal(validatePanelPrompts(prompts).length, 25);
  });

  it(`rejects fewer than ${GEO_PANEL_MIN_PROMPTS} prompts`, () => {
    assert.throws(
      () => validatePanelPrompts(["one?", "two?"]),
      (e) => e instanceof GeoPanelValidationError && /at least 12/.test(e.message),
    );
  });

  it(`rejects more than ${GEO_PANEL_MAX_PROMPTS} prompts`, () => {
    const prompts = Array.from({ length: 26 }, (_, i) => `Prompt ${i}?`);
    assert.throws(
      () => validatePanelPrompts(prompts),
      (e) => e instanceof GeoPanelValidationError && /caps at 25/.test(e.message),
    );
  });

  it("rejects empty and duplicate prompts", () => {
    assert.throws(
      () => validatePanelPrompts([...dozen.slice(0, 11), "   "]),
      GeoPanelValidationError,
    );
    const dup = [...dozen.slice(0, 11), dozen[0]];
    assert.throws(
      () => validatePanelPrompts(dup),
      (e) => e instanceof GeoPanelValidationError && /Duplicate/.test(e.message),
    );
  });

  it("trims whitespace and drops non-strings", () => {
    const raw = [...dozen.slice(0, 11), "  a real buyer question about onboarding?  ", 42, null];
    const out = validatePanelPrompts(raw);
    assert.equal(out.length, 12);
    assert.equal(out[11], "a real buyer question about onboarding?");
  });
});

describe("nextPanelVersion", () => {
  it("starts at 1", () => {
    assert.equal(nextPanelVersion([]), 1);
  });

  it("increments past the max existing version", () => {
    assert.equal(nextPanelVersion([1, 2, 3]), 4);
    assert.equal(nextPanelVersion([1, 3]), 4); // never reuses a version
  });
});
