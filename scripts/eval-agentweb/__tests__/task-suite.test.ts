// Phase 21A (WS=agentweb): the task suite on local fixture sites, dry run (no
// model is involved in these steps). Shows the channel ladder choosing the best
// rung a site offers, falling back to the page's controls, and stopping where a
// person has to act.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SUITE, runTaskSuite } from "../tasks";

describe("task suite (fixture sites)", async () => {
  const { runs, stats } = await runTaskSuite();

  for (const t of SUITE) {
    it(`${t.id}: chooses ${t.expectedChannel} and succeeds`, () => {
      const r = runs.find((x) => x.id === t.id)!;
      assert.equal(r.channel, t.expectedChannel);
      assert.equal(r.ok, true, `${r.error ?? ""} ${r.answer}`);
    });
  }

  it("money and deletion tasks stop at the person-only step and submit nothing", () => {
    for (const id of ["buy-starter-plan", "delete-account"]) assert.equal(runs.find((r) => r.id === id)!.handedOff, true, id);
  });

  it("reports success rate, steps and time per channel", () => {
    assert.deepEqual(stats.map((s) => s.channel).sort(), ["a11y-tree", "declared-tools", "documented-api", "structured-data"]);
    for (const s of stats) assert.equal(s.successRate, 1, s.channel);
    assert.ok(stats.every((s) => s.avgMs >= 0 && s.costMicroUsd === 0));
  });
});
