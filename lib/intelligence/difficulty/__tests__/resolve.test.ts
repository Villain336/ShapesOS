// Marketr — Phase 10 M5: M5-GATE seam tests (vendor-replacement resolver).
// Run: npx tsx --test lib/intelligence/difficulty/__tests__/resolve.test.ts
// No network, no API keys, no DB — the gate and the estimator are injected.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveIdeaDifficulties, estimateFromFixture, type EstimateOutcome, type IdeaDifficulty } from "../service";
import { shouldReplaceVendor } from "../gate";
import { FIXTURE_BY_KEYWORD } from "../fixtures";
import type { EstimateRow } from "../store";

const IDEAS: IdeaDifficulty[] = [
  { phrase: "insurance", difficulty: 85 },
  { phrase: "best ergonomic office chair for short people under $200", difficulty: 12 },
  { phrase: "project management software for small teams", difficulty: 61 },
];

/** A canned successful model outcome built from a synthetic fixture (no I/O). */
function fakeModelOutcome(keyword: string): EstimateOutcome {
  const f = FIXTURE_BY_KEYWORD.get(keyword);
  assert.ok(f, `fixture ${keyword} exists`);
  const output = estimateFromFixture({
    keyword: f.keyword,
    locale: f.locale,
    serp: f.serp,
    authorityRaw: f.authority,
    volumeBand: f.volumeBand,
    volumeSource: "test",
    serpVendor: "test",
  });
  const row: EstimateRow = {
    id: "row-test",
    keyword,
    locale: "en-US",
    estimate: output.estimate,
    uncertaintyBand: output.uncertaintyBand,
    inputsProvenance: output.inputsProvenance,
    modelVersion: output.modelVersion,
    evaluatedAt: new Date(),
  };
  return { ok: true, output, row, experimental: true };
}

describe("M5-GATE: below the bar the gate blocks replacement", () => {
  it("vendor difficulty passes through untouched when the gate is closed", async () => {
    // eval-state.json records no PASS for the current model version.
    assert.equal(shouldReplaceVendor(), false);
    let modelCalls = 0;
    const { ideas, replaced } = await resolveIdeaDifficulties("ws-test", IDEAS, "en-US", {
      estimate: async () => {
        modelCalls++;
        throw new Error("the model must not run while the gate is closed");
      },
    });
    assert.equal(replaced, false);
    assert.equal(modelCalls, 0);
    assert.deepEqual(
      ideas.map((i) => i.difficulty),
      [85, 12, 61],
    );
    assert.ok(
      ideas.every((i) => i.difficultySource !== "model"),
      "nothing may be marked model-sourced while the gate is closed",
    );
  });
});

describe("M5-GATE: when the gate opens the model replaces the vendor value", () => {
  it("replaces difficulty and marks the source as model", async () => {
    const { ideas, replaced } = await resolveIdeaDifficulties("ws-test", IDEAS, "en-US", {
      gateOpen: () => true,
      estimate: async (_ws, keyword) => fakeModelOutcome(keyword),
    });
    assert.equal(replaced, true);
    for (const idea of ideas) {
      assert.equal(idea.difficultySource, "model");
      assert.ok(
        typeof idea.difficulty === "number" && idea.difficulty >= 0 && idea.difficulty <= 100,
      );
    }
    // The model orders the fixtures easy < medium < hard.
    const byPhrase = new Map(ideas.map((i) => [i.phrase, i.difficulty!]));
    assert.ok(
      byPhrase.get("best ergonomic office chair for short people under $200")! <
        byPhrase.get("project management software for small teams")! &&
        byPhrase.get("project management software for small teams")! <
          byPhrase.get("insurance")!,
      "model replacement must preserve the easy < medium < hard ordering",
    );
  });

  it("a refused estimate keeps the vendor value (never invents difficulty)", async () => {
    const { ideas, replaced } = await resolveIdeaDifficulties("ws-test", IDEAS, "en-US", {
      gateOpen: () => true,
      estimate: async () => ({ ok: false, reason: "no SERP vendor", missing: ["serp"] }),
    });
    assert.equal(replaced, true);
    assert.deepEqual(
      ideas.map((i) => i.difficulty),
      [85, 12, 61],
    );
    assert.ok(ideas.every((i) => i.difficultySource === "vendor"));
  });

  it("a throwing estimator keeps the vendor value", async () => {
    const { ideas } = await resolveIdeaDifficulties("ws-test", IDEAS, "en-US", {
      gateOpen: () => true,
      estimate: async () => {
        throw new Error("network down");
      },
    });
    assert.deepEqual(
      ideas.map((i) => i.difficulty),
      [85, 12, 61],
    );
    assert.ok(ideas.every((i) => i.difficultySource === "vendor"));
  });
});
