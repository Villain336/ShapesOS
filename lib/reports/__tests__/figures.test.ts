// Marketr — Phase 16 slice 9: figure grounding tests.
// Run: npx tsx --test lib/reports/__tests__/figures.test.ts
//
// Proves Tico's iron guardrail: a figure with no connected source is flagged
// for review and NEVER renders — assertFiguresGrounded throws with the exact
// ungrounded keys.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateFigures,
  assertFiguresGrounded,
  UngroundedFiguresError,
  type ReportFigure,
} from "@/lib/reports/figures";

function grounded(key: string): ReportFigure {
  return {
    key,
    label: `Label ${key}`,
    value: "12,480",
    source: { provider: "dataforseo", ref: "job-abc-123" },
  };
}

function sourceless(key: string): ReportFigure {
  return { key, label: `Label ${key}`, value: "99" };
}

describe("figure grounding", () => {
  it("passes when every figure carries a source pointer", () => {
    const result = evaluateFigures([grounded("a"), grounded("b")]);
    assert.equal(result.allGrounded, true);
    assert.deepEqual(result.ungroundedKeys, []);
    assertFiguresGrounded([grounded("a"), grounded("b")]); // no throw
  });

  it("flags figures with no source (absent, null, or empty)", () => {
    const figs: ReportFigure[] = [
      grounded("ok"),
      sourceless("missing"),
      { ...grounded("empty"), source: { provider: "", ref: "" } },
      { ...grounded("nullish"), source: null },
    ];
    const result = evaluateFigures(figs);
    assert.equal(result.allGrounded, false);
    assert.deepEqual(result.ungroundedKeys, ["missing", "empty", "nullish"]);
  });

  it("assertFiguresGrounded throws with the ungrounded keys — never renders", () => {
    let caught: unknown;
    try {
      assertFiguresGrounded([grounded("ok"), sourceless("bad-one")]);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof UngroundedFiguresError);
    assert.deepEqual((caught as UngroundedFiguresError).ungroundedKeys, ["bad-one"]);
    assert.match((caught as Error).message, /Refusing to render/);
  });

  it("requires BOTH provider and ref", () => {
    const half = { ...grounded("half"), source: { provider: "gsc", ref: "" } };
    assert.equal(evaluateFigures([half]).allGrounded, false);
  });
});
