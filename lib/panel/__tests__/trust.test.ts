// Phase 19B (WS=panel) — in-character monitors and the calibration validator.
// Ported from the prototype's test/propositions.test.ts (7) and
// test/validator.test.ts (9). Added: a cap stop inside a monitor propagates
// (the prototype swallowed it), and the run-vs-launch comparison.
// Validator numbers are the prototype's hand-checked worked examples.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLlmProvider, type MockChatStep } from "@/lib/llm/mock";
import type { ChatRequest } from "@/lib/llm/types";
import { PanelCapReachedError, PanelLedger } from "../budget";
import { RouterPanelModel } from "../model";
import { personaAdherenceHook, selfConsistencyHook } from "../trust";
import { calibrationScore, comparePredictionVsReality, compareRunWithLaunch, verdictToScore, type PanelVerdict } from "../validator";
import type { WalkthroughStep } from "../walk";
import { mkObs, mkSignals, validSpec } from "./fixtures";

const PERSONA = validSpec({
  identity: { name: "Rita Bootstrapper", role: "Founder" },
  budget: { currency: "USD", monthlyMax: 50, hardCap: true, notes: "Self-funded; no room for waste" },
  beliefs: ["Every dollar of spend must be justified"],
});

function step(i: number, thinkAloud: string): WalkthroughStep {
  return {
    stepIndex: i,
    startedAt: 0,
    endedAt: 1200,
    intent: { action: "read", target: "Pricing", value: null, finish: null },
    thinkAloud,
    observation: mkObs({ type: "read", textExcerpt: "Pricing: $49/mo, billed annually ($588 charged today)." }),
    signals: mkSignals(),
    flags: [],
  };
}

const judge = (input: unknown): MockChatStep => ({ content: [{ type: "tool_use", id: "j", name: "submit_judgement", input: input as Record<string, unknown> }], model: "claude-haiku-4-5", usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } });

function model(script: MockChatStep[], cap = 100) {
  const provider = new MockLlmProvider({ chatScript: script });
  const ledger = new PanelLedger();
  ledger.beginRun("run", cap);
  return { provider, ledger, model: new RouterPanelModel(provider, "claude-haiku-4-5", ledger) };
}

describe("personaAdherenceHook", () => {
  it("flags a step that contradicts the persona's hard budget cap", async () => {
    const m = model([judge({ passed: false, detail: "Thinks the $500/mo plan looks fine despite a $50/mo HARD CAP." })]);
    const flags = await personaAdherenceHook({ model: m.model, personaSpec: PERSONA, runId: "run" })(step(0, "The $500/mo plan looks fine, I should just sign up."));
    assert.equal(m.provider.chatCalls.length, 1);
    assert.deepEqual(flags, [{ check: "persona_adherence", passed: false, detail: "Thinks the $500/mo plan looks fine despite a $50/mo HARD CAP." }]);
    assert.match(String(m.provider.chatCalls[0]!.messages[0]!.content), /HARD CAP/);
    assert.equal(m.ledger.spend("run").callCount, 1);
  });

  it("stays silent on a step consistent with the persona", async () => {
    const m = model([judge({ passed: true, detail: "" })]);
    assert.deepEqual(await personaAdherenceHook({ model: m.model, personaSpec: PERSONA, runId: "run" })(step(0, "$49/mo is within my $50 cap.")), []);
  });

  it("returns no flags when the judge's answer is malformed (advisory monitor)", async () => {
    for (const bad of [{ content: [{ type: "text" as const, text: "not json at all" }] }, judge({ passed: "yes", detail: "wrong shape" })]) {
      const m = model([bad]);
      assert.deepEqual(await personaAdherenceHook({ model: m.model, personaSpec: PERSONA, runId: "run" })(step(0, "Whatever I think.")), []);
    }
  });

  it("a cap stop is NOT advisory: it propagates out of the monitor", async () => {
    const m = model([judge({ passed: true, detail: "" })], 0);
    await assert.rejects(async () => personaAdherenceHook({ model: m.model, personaSpec: PERSONA, runId: "run" })(step(0, "x")), PanelCapReachedError);
  });
});

describe("selfConsistencyHook", () => {
  it("flags a flip-flop against the persona's own earlier position", async () => {
    const m = model([judge({ passed: false, detail: "Step 0 said pricing is too high; now reasonable with no new evidence." })]);
    const hook = selfConsistencyHook({ model: m.model, runId: "run", windowN: 3 });
    const f0 = await hook(step(0, "Pricing is way too high for me."));
    const f1 = await hook(step(1, "Actually, the pricing seems reasonable now."));
    assert.equal(m.provider.chatCalls.length, 1, "the first step has no history: no judge call");
    assert.deepEqual(f0, []);
    assert.equal(f1[0]?.check, "self_consistency");
    assert.match(f1[0]!.detail, /no new evidence/);
  });

  it("ignores consistent walks", async () => {
    const m = model([judge({ passed: true, detail: "" })]);
    const hook = selfConsistencyHook({ model: m.model, runId: "run", windowN: 2 });
    for (let i = 0; i < 4; i++) assert.deepEqual(await hook(step(i, "Still too expensive.")), []);
  });

  it("returns no flags when the judge's answer is malformed", async () => {
    const m = model([{ content: [{ type: "text", text: "<not json>" }] }]);
    const hook = selfConsistencyHook({ model: m.model, runId: "run" });
    await hook(step(0, "Pricing is too high."));
    assert.deepEqual(await hook(step(1, "Pricing is reasonable.")), []);
  });

  it("only compares against the last windowN steps", async () => {
    const seen: string[] = [];
    const m = model([(req: ChatRequest) => (seen.push(String(req.messages[0]!.content)), judge({ passed: true, detail: "" }) as never)]);
    const hook = selfConsistencyHook({ model: m.model, runId: "run", windowN: 1 });
    await hook(step(0, "POSITION-ALPHA: pricing too high."));
    await hook(step(1, "POSITION-BETA: still too high."));
    await hook(step(2, "Consistent with beta."));
    const earlier = (s: string) => s.split("[Current thinking")[0] ?? "";
    assert.equal(seen.length, 2);
    assert.match(earlier(seen[0]!), /POSITION-ALPHA/);
    assert.doesNotMatch(earlier(seen[0]!), /POSITION-BETA/);
    assert.match(earlier(seen[1]!), /POSITION-BETA/);
    assert.doesNotMatch(earlier(seen[1]!), /POSITION-ALPHA/);
  });
});

/** 25-persona panel: 15 buy, 5 no-buy, 5 maybe → predicted 0.70; 14 of 25 really bought → 0.56. */
function fabricate25(): { predicted: PanelVerdict[]; actual: boolean[] } {
  return {
    predicted: [...Array<PanelVerdict>(15).fill("buy"), ...Array<PanelVerdict>(5).fill("no-buy"), ...Array<PanelVerdict>(5).fill("maybe")],
    actual: [...Array<boolean>(14).fill(true), ...Array<boolean>(11).fill(false)],
  };
}

describe("validator (the track record)", () => {
  it("maybe counts as half", () => {
    assert.deepEqual([verdictToScore("buy"), verdictToScore("no-buy"), verdictToScore("maybe")], [1, 0, 0.5]);
  });

  it("computes z/p on a 25-persona panel and buckets within-noise (hand-checked: z≈1.0252, p≈0.3053)", () => {
    const r = comparePredictionVsReality(fabricate25());
    assert.equal(r.test, "two-proportion z-test");
    assert.equal(r.n, 25);
    assert.ok(Math.abs(r.predictedRate - 0.7) < 1e-10);
    assert.ok(Math.abs(r.actualRate - 0.56) < 1e-10);
    assert.ok(Math.abs(r.z - 1.0252) < 0.001);
    assert.ok(Math.abs(r.pValue - 0.3053) < 0.001);
    assert.equal(r.verdict, "within-noise");
  });

  it("buckets over-predicting when the panel is optimistic and significant", () => {
    const r = comparePredictionVsReality({ predicted: Array<PanelVerdict>(25).fill("buy"), actual: [...Array<boolean>(10).fill(true), ...Array<boolean>(15).fill(false)] });
    assert.ok(Math.abs(r.delta - 0.6) < 1e-10);
    assert.ok(r.z > 1.96 && r.pValue < 0.05);
    assert.equal(r.verdict, "over-predicting");
  });

  it("buckets under-predicting when the panel is pessimistic and significant", () => {
    const r = comparePredictionVsReality({ predicted: Array<PanelVerdict>(25).fill("no-buy"), actual: [...Array<boolean>(20).fill(true), ...Array<boolean>(5).fill(false)] });
    assert.ok(Math.abs(r.delta + 0.8) < 1e-10);
    assert.equal(r.verdict, "under-predicting");
  });

  it("handles zero-variance inputs without NaN", () => {
    const r = comparePredictionVsReality({ predicted: Array<PanelVerdict>(10).fill("no-buy"), actual: Array<boolean>(10).fill(false) });
    assert.deepEqual([r.delta, r.z, r.pValue, r.verdict], [0, 0, 1, "within-noise"]);
  });

  it("rejects empty and mismatched inputs", () => {
    assert.throws(() => comparePredictionVsReality({ predicted: [], actual: [] }), /at least one/);
    assert.throws(() => comparePredictionVsReality({ predicted: ["buy"], actual: [true, false] }), /equal length/);
  });

  it("calibration score is the mean absolute error across launches", () => {
    assert.ok(Math.abs(calibrationScore([{ predictedRate: 0.7, actualRate: 0.56 }, { predictedRate: 0.4, actualRate: 0.5 }]) - 0.12) < 1e-10);
  });

  it("feeds off a comparison", () => {
    const r = comparePredictionVsReality(fabricate25());
    assert.ok(Math.abs(calibrationScore([r]) - 0.14) < 1e-10);
  });

  it("rejects an empty history", () => {
    assert.throws(() => calibrationScore([]), /at least one launch/);
  });

  it("compares a run's verdicts with a launch's conversions out of visitors", () => {
    // 2 buy + 1 maybe of 4 → 2.5 / 4 = 0.625 predicted; 30 of 1000 visitors converted → 0.03.
    const r = compareRunWithLaunch({ predicted: ["buy", "buy", "maybe", "no-buy"], conversions: 30, visitors: 1000 });
    assert.equal(r.predictedRate, 0.625);
    assert.equal(r.actualRate, 0.03);
    assert.equal(r.actualN, 1000);
    // Pooled p = 32.5 / 1004; se = sqrt(p(1-p)(1/4 + 1/1000)) ≈ 0.08867 → z ≈ 6.7104 (worked by hand).
    assert.ok(Math.abs(r.z - 6.7104) < 0.001);
    assert.equal(r.verdict, "over-predicting");
    assert.throws(() => compareRunWithLaunch({ predicted: [], conversions: 1, visitors: 10 }), /No verdicts/);
    assert.throws(() => compareRunWithLaunch({ predicted: ["buy"], conversions: 11, visitors: 10 }), /between 0 and visitors/);
  });
});
