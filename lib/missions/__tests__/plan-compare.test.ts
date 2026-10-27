// Pure comparison of declared plan variants. No imports beyond the module, so it runs locally.
// Run: npx tsx --test lib/missions/__tests__/plan-compare.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { comparePlans, type CompareStep } from "../plan-compare";

const st = (key: string, o: Partial<CompareStep> = {}): CompareStep => ({ key, title: key.toUpperCase(), kind: "draft", executor: "drafter", tier: 0, checkpointAfter: false, ...o });

describe("comparePlans", () => {
  it("marks steps the second variant lacks and keeps baseline order", () => {
    const r = comparePlans([
      { id: "full", label: "Full", steps: [st("a"), st("b", { tier: 1, executor: "actor" }), st("c")] },
      { id: "drafts", label: "Drafts", steps: [st("a"), st("c")] },
    ]);
    assert.deepEqual(r.rows.map((x) => x.key), ["a", "b", "c"]);
    assert.deepEqual(r.rows.map((x) => x.diff[1]), ["same", "missing", "same"]);
    assert.equal(r.rows[1].cells[1], null);
    assert.deepEqual(r.summary[1], { id: "drafts", label: "Drafts", missingFromBaseline: 1, notInBaseline: 0, changed: 0 });
  });
  it("reports a changed step and a step only the other variant has", () => {
    const r = comparePlans([
      { id: "x", label: "X", steps: [st("a")] },
      { id: "y", label: "Y", steps: [st("a", { checkpointAfter: true }), st("z")] },
    ]);
    assert.deepEqual(r.rows.map((x) => x.diff[1]), ["changed", "changed"]);
    assert.equal(r.rows[1].cells[0], null);
    assert.deepEqual(r.summary[1], { id: "y", label: "Y", missingFromBaseline: 0, notInBaseline: 1, changed: 1 });
  });
  it("handles a single variant and no variants", () => {
    assert.equal(comparePlans([{ id: "x", label: "X", steps: [st("a")] }]).rows[0].diff[0], "same");
    assert.deepEqual(comparePlans([]).rows, []);
  });
});
