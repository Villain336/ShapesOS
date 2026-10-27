// Drafts-only invariants, read from the REAL executor allow-lists
// (imports the executors, so it needs the app dependencies; runs in CI).
// Run: npx tsx --test lib/missions/__tests__/plan-alternatives-invariants.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlanAlternatives } from "../plan-alternatives";
import { MISSION_TEMPLATES } from "../templates";

// ---- Invariants read from the real executor allow-lists and templates ----
import { EXECUTOR_ALLOW_LISTS } from "../../orchestrator/executor-grants";
import { DRAFT_SAFE_EXECUTORS } from "../plan-alternatives";

describe("drafts-only invariants (source-backed)", () => {
  it("no retained executor can invoke a connected-app action; only `actor` holds that tool", () => {
    const holders = Object.entries(EXECUTOR_ALLOW_LISTS).filter(([, tools]) => tools.includes("actions.invoke")).map(([e]) => e);
    assert.deepEqual(holders, ["actor"]);
    for (const e of DRAFT_SAFE_EXECUTORS) assert.ok(!EXECUTOR_ALLOW_LISTS[e as keyof typeof EXECUTOR_ALLOW_LISTS].includes("actions.invoke"), e);
    assert.ok(!DRAFT_SAFE_EXECUTORS.includes("actor") && !DRAFT_SAFE_EXECUTORS.includes("human"));
  });
  it("every template: retained steps are tier 0, non-approval, draft-safe executors, with no dangling prose", () => {
    for (const t of MISSION_TEMPLATES) {
      const alt = buildPlanAlternatives(t).find((a) => a.id === "drafts-only");
      if (!alt) continue;
      const kept = new Set(alt.steps.map((s) => s.key));
      const removed = t.plan.filter((s) => !kept.has(s.key));
      assert.ok(removed.length > 0, `${t.id} variant must differ`);
      for (const s of alt.steps) {
        assert.equal(s.tier, 0, `${t.id}/${s.key}`);
        assert.notEqual(s.kind, "approval");
        assert.ok(DRAFT_SAFE_EXECUTORS.includes(s.executor), `${t.id}/${s.key} executor ${s.executor}`);
        for (const r of removed) {
          assert.ok(!s.description.includes(r.key) && !s.description.includes(r.title), `${t.id}/${s.key} refers to removed step ${r.key}`);
        }
        // prose that leans on an approval/publish step carries the plain note instead
        if (/approv|gate|publish|send/i.test(t.plan.find((x) => x.key === s.key)!.description)) {
          assert.match(s.description, /no step sends or publishes/);
        }
      }
      assert.deepEqual(alt.steps.map((s) => s.order), alt.steps.map((_, i) => i + 1));
      assert.deepEqual(alt.omitted.sort(), removed.map((r) => r.title).sort());
    }
  });
  it("no variant is offered whose only difference is the checkpointAfter label", () => {
    for (const t of MISSION_TEMPLATES) {
      const ids = buildPlanAlternatives(t).map((a) => a.id);
      assert.ok(!(ids as string[]).includes("review-first"));
    }
  });
});
