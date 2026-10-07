// Phase 19B (WS=engine) — decision points: the cache keyed by (resident
// state hash, stimulus) — a hit makes no model call and costs nothing — and
// the rules fallback when a model answer fails its schema twice.
// The model is the labelled FAKE town model, or a scripted MockLlmProvider.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PanelLedger } from "@/lib/panel/budget";
import { RouterPanelModel } from "@/lib/panel/model";
import { MockLlmProvider } from "@/lib/llm/mock";
import { DecisionCache, decisionKey, ModelDecider, type DecisionFacts, type DecisionRequest } from "../decisions";
import { fakeTownModel } from "../fake-model";

function facts(over: Partial<DecisionFacts> = {}): DecisionFacts {
  return {
    residentId: "r001",
    residentName: "Ana R.",
    segment: "buyers",
    persona: { name: "Dana Reyes", occupation: "Operations Manager", goals: ["cut reporting time"], knownObjections: ["Too expensive for our team size"] },
    calibrated: true,
    traits: { priceSensitivity: 0.5, adOpenness: 0.6, sociability: 0.5, skepticism: 0.4 },
    moneyCents: 50_000,
    productBudgetLeftCents: 20_000,
    interest: 0.3,
    adopted: false,
    product: { name: "Trail mix", category: "snacks", priceCents: 900, description: "" },
    effectivePriceCents: 900,
    discountPct: 0,
    weather: "sunny",
    when: "Monday (day 1) 19:00",
    stimulus: { channel: "social", creative: "New trail mix downtown" },
    memories: [],
    ...over,
  };
}

const req = (f: DecisionFacts): DecisionRequest => ({ point: "ad", residentId: f.residentId, key: decisionKey("ad", f), facts: f });

function counted() {
  const ledger = new PanelLedger();
  ledger.beginRun("run", 10_000);
  let calls = 0;
  const decider = new ModelDecider(fakeTownModel(ledger, { onCall: () => (calls += 1) }), new DecisionCache());
  return { decider, ledger, calls: () => calls };
}

describe("decision cache", () => {
  it("a cache hit makes no model call and costs 0 credits", async () => {
    const { decider, ledger, calls } = counted();
    const [first] = await decider.decideMany("run", [req(facts())]);
    assert.equal(first!.source, "model");
    assert.equal(calls(), 1);
    const spent = ledger.spend("run").spentCredits;
    const [second] = await decider.decideMany("run", [req(facts())]);
    assert.equal(second!.source, "cache");
    assert.equal(second!.credits, 0);
    assert.deepEqual(second!.value, first!.value);
    assert.equal(calls(), 1, "no second model call");
    assert.equal(ledger.spend("run").spentCredits, spent, "nothing more spent");
  });

  it("the same key twice in one batch is asked once", async () => {
    const { decider, calls } = counted();
    const out = await decider.decideMany("run", [req(facts()), req(facts())]);
    assert.equal(calls(), 1);
    assert.deepEqual(out.map((d) => d.source), ["model", "cache"]);
  });

  it("a different stimulus or state misses; different memories alone hit", async () => {
    const base = decisionKey("ad", facts());
    assert.notEqual(decisionKey("ad", facts({ effectivePriceCents: 1_500 })), base, "price is part of the stimulus");
    assert.notEqual(decisionKey("ad", facts({ interest: 0.8 })), base, "interest is part of the state");
    assert.notEqual(decisionKey("ad", facts({ residentId: "r002" })), base, "per resident");
    assert.equal(decisionKey("ad", facts({ memories: ["I saw a billboard yesterday."] })), base, "memories are not in the key (stated trade-off)");
  });

  it("a cache seeded from a past run's decisions answers a replay with no calls", async () => {
    const { decider } = counted();
    const [d] = await decider.decideMany("run", [req(facts())]);
    const ledger = new PanelLedger();
    ledger.beginRun("replay", 10_000);
    let calls = 0;
    const replay = new ModelDecider(fakeTownModel(ledger, { onCall: () => (calls += 1) }), new DecisionCache([[d!.key, d!.value]]));
    const [again] = await replay.decideMany("replay", [req(facts())]);
    assert.equal(again!.source, "cache");
    assert.equal(calls, 0);
  });
});

describe("schema failures", () => {
  it("an answer that fails its schema twice falls back to rules, labelled, and is not cached", async () => {
    const ledger = new PanelLedger();
    ledger.beginRun("run", 10_000);
    const bad = new MockLlmProvider({ chatScript: [{ content: [{ type: "tool_use", id: "t", name: "react_to_ad", input: { attention: "maybe?" } }], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }] });
    const cache = new DecisionCache();
    const decider = new ModelDecider(new RouterPanelModel(bad, "claude-haiku-4-5", ledger, { kind: "fake" }), cache);
    const [d] = await decider.decideMany("run", [req(facts())]);
    assert.equal(d!.source, "rules");
    assert.match(d!.note ?? "", /invalid twice/);
    assert.ok(["ignore", "curious", "plan_visit"].includes((d!.value as { attention: string }).attention));
    assert.equal(cache.size, 0);
    assert.equal(ledger.spend("run").callCount, 2, "both attempts were charged");
  });
});
