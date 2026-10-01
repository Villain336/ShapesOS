// Marketr — Wave 2 context.dev slice 3 tests: research contract (pure).
// Run: npx tsx --test lib/knowledge/contextdev/__tests__/research.test.ts
//
// Pure: no database, no network. Covers the citation contract (zero sources
// are refused, never stored silently), the confidence heuristic, and the
// mode → credit-cost mapping. The DB-touching runResearch stays thin over
// these.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  confidenceForAnswer,
  validateAnswerContract,
  ResearchError,
  DEFAULT_RESEARCH_MODE,
} from "../research";
import { contextDevCreditsFor } from "../costs";

describe("validateAnswerContract", () => {
  it("accepts an answer with at least one source", () => {
    validateAnswerContract({
      jsonContent: { plans: [] },
      sources: ["https://example.com/pricing"],
      partial: false,
    });
  });

  it("refuses a zero-source answer with NO_SOURCES", () => {
    assert.throws(
      () =>
        validateAnswerContract({ jsonContent: { plans: [] }, sources: [], partial: false }),
      (e: unknown) => {
        assert.ok(e instanceof ResearchError && e.code === "NO_SOURCES");
        return true;
      },
    );
  });
});

describe("confidenceForAnswer", () => {
  it("scores zero sources lowest", () => {
    assert.equal(confidenceForAnswer(0, false), 0.2);
  });

  it("penalizes partial answers", () => {
    assert.equal(confidenceForAnswer(5, true), 0.4);
    assert.ok(confidenceForAnswer(5, true) < confidenceForAnswer(5, false));
  });

  it("rewards more sources", () => {
    assert.ok(confidenceForAnswer(3, false) > confidenceForAnswer(1, false));
    assert.ok(confidenceForAnswer(1, false) > confidenceForAnswer(0, false));
  });

  it("stays within [0, 1]", () => {
    for (const n of [0, 1, 2, 3, 10, 100]) {
      for (const p of [true, false]) {
        const c = confidenceForAnswer(n, p);
        assert.ok(c >= 0 && c <= 1, `confidence ${c} out of range`);
      }
    }
  });
});

describe("research mode economics", () => {
  it("defaults to fast — ultra is 10x and needs explicit opt-in", () => {
    assert.equal(DEFAULT_RESEARCH_MODE, "fast");
    assert.equal(contextDevCreditsFor("answers_fast"), 10);
    assert.equal(contextDevCreditsFor("answers_ultra"), 100);
  });
});
