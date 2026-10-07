// Phase 19A (WS=server): the user-set spend cap (AgentRun.budgetMicroUsd).
//   - the loop stops BEFORE a model call that would cross the cap (fake model
//     with a priced usage per call), and says it was the spend cap;
//   - splitBudget never gives children more than what is left of the cap,
//     and refuses cleanly when the cap is used up.
// Run: env -u DATABASE_URL npx tsx --test lib/agents/__tests__/run-budget.test.ts

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { MockLlmProvider, type MockChatStep } from "@/lib/llm/mock";
import { registerExtraTool, type ToolDef } from "@/lib/chat/tools";
import { memoryTranscriptStore } from "@/lib/agents/runs/transcript";
import { runAgentLoop, type LoopContext } from "../loop";
import { MIN_CHILD_BUDGET, splitBudget } from "../delegation/plan";

const t_look: ToolDef = {
  name: "t_budget_look",
  description: "Look something up.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    return { summary: "looked" };
  },
};

before(() => registerExtraTool(t_look));

const ctx = (): LoopContext => ({
  projectId: "p1",
  workspaceId: "ws-budget",
  userId: "u1",
  role: "editor",
  confirmed: false,
  agentKey: "lead",
  grant: null,
  runId: "run-budget",
});

/** Every call uses the tool again and costs `micro` (a fake model with a priced usage). */
function pricedProvider(micro: number) {
  let n = 0;
  const step: MockChatStep = () => ({
    content: [{ type: "tool_use", id: `tu_${++n}`, name: "t_budget_look", input: {} }],
    costMicroUsd: micro,
  });
  return new MockLlmProvider({ chatScript: [step] });
}

describe("run spend cap in the loop", () => {
  it("stops before the call that would cross the cap ($0.01 cap, $0.003 per call → 3 calls)", async () => {
    const provider = pricedProvider(3_000);
    const r = await runAgentLoop({
      ctx: ctx(),
      system: "test",
      messages: [{ role: "user", content: "go" }],
      deps: { provider, store: memoryTranscriptStore(), persistEvents: false, runBudget: async () => 10_000 },
    });
    assert.equal(r.status, "capped");
    assert.equal(r.cap, "cost");
    assert.equal(provider.chatCalls.length, 3, "3 × $0.003 = $0.009; a 4th ($0.012) would cross $0.01");
    assert.ok(r.state.costMicroUsd <= 10_000, `spent ${r.state.costMicroUsd} > cap`);
    assert.match(r.finalText, /spend cap/);
  });

  it("without a cap the platform limit applies (no spend-cap wording)", async () => {
    const provider = pricedProvider(3_000);
    const r = await runAgentLoop({
      ctx: ctx(),
      system: "test",
      messages: [{ role: "user", content: "go" }],
      limits: { maxCostMicroUsd: 10_000 },
      deps: { provider, store: memoryTranscriptStore(), persistEvents: false, runBudget: async () => null },
    });
    assert.equal(r.status, "capped");
    assert.doesNotMatch(r.finalText, /spend cap/);
  });

  it("a cap lower than the platform limit wins", async () => {
    const provider = pricedProvider(1_000);
    const r = await runAgentLoop({
      ctx: ctx(),
      system: "test",
      messages: [{ role: "user", content: "go" }],
      limits: { maxCostMicroUsd: 1_000_000_000 },
      deps: { provider, store: memoryTranscriptStore(), persistEvents: false, runBudget: async () => 2_500 },
    });
    assert.equal(r.cap, "cost");
    assert.equal(provider.chatCalls.length, 2);
  });
});

describe("splitBudget under a spend cap", () => {
  const left = { costMicroUsd: 10_000_000, steps: 40, ms: 30 * 60_000 };
  it("children never exceed what is left of the cap", () => {
    for (const cap of [3_000_000, 1_000_000, 250_000, 100_000]) {
      for (const n of [1, 2, 3, 5]) {
        const tasks = Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
        const r = splitBudget(left, tasks, { capLeftMicroUsd: cap });
        assert.equal(r.ok, true, `cap ${cap}, ${n} tasks`);
        if (!r.ok) continue;
        const sum = Object.values(r.split.perTask).reduce((s, b) => s + b.costMicroUsd, 0);
        assert.ok(sum + r.split.reserve.costMicroUsd <= cap, `Σ children ${sum} + reserve over cap ${cap}`);
      }
    }
  });
  it("explicit shares stay inside the cap too", () => {
    const r = splitBudget(left, [{ id: "a", budgetShare: 0.7 }, { id: "b", budgetShare: 0.3 }], { capLeftMicroUsd: 2_000_000 });
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.split.perTask.a!.costMicroUsd + r.split.perTask.b!.costMicroUsd <= 2_000_000 * 0.8);
  });
  it("refuses cleanly when the cap is used up", () => {
    const r = splitBudget(left, [{ id: "a" }, { id: "b" }], { capLeftMicroUsd: 0 });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.capExhausted, true);
      assert.match(r.error, /spend cap/);
    }
    const tiny = splitBudget(left, [{ id: "a" }], { capLeftMicroUsd: MIN_CHILD_BUDGET.costMicroUsd });
    assert.equal(tiny.ok, false);
  });
  it("no cap → unchanged behaviour", () => {
    const a = splitBudget(left, [{ id: "a" }, { id: "b" }]);
    const b = splitBudget(left, [{ id: "a" }, { id: "b" }], { capLeftMicroUsd: null });
    assert.deepEqual(a, b);
  });
});
