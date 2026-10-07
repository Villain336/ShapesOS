// Phase 19B (WS=panel) — the cap maths, the parallel caps and the whole
// pure pipeline (derive → walk → verdict → report) on the labelled FAKE
// model and the fake page. New in ShapesOS (the prototype had no estimate).
//
// Worked example — estimateRun("claude-haiku-4-5", 3 personas, 8 steps):
//   step    7,000 chars → 2,800 in + 500 out  = $0.0053 → 0.795 → 1 credit
//   judge   3,500 chars → 1,400 in + 200 out  = $0.0024 → 0.36  → 1 credit
//   verdict 5,000 + 8 × 1,000 = 13,000 chars → 5,200 in + 1,200 out = $0.0112 → 1.68 → 2 credits
//   fix     2,500 chars → 1,000 in + 300 out  = $0.0025 → 0.375 → 1 credit
//   per persona = 8 × (1 + 2 × 1) + 2 = 26;  run = 3 × 26 + 5 × 1 = 83 credits

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateReport } from "../aggregate";
import { PanelLedger } from "../budget";
import { derivePersonaSpec } from "../derive";
import { clampStepCap, estimateDerivation, estimateRun, panelLimits, runPool } from "../estimate";
import { createFakePanelProvider, fakeModelAllowed, FAKE_MODEL_PRICED_AS } from "../fake-model";
import { InMemoryMemoryStore } from "../memory";
import { RouterPanelModel } from "../model";
import { runReflections } from "../reflections";
import { buildTimeline } from "../timeline";
import { personaAdherenceHook, selfConsistencyHook } from "../trust";
import { verdictOrWithheld } from "../verdicts";
import { runWalkthrough } from "../walk";
import { FakeWalkPage, INTERVIEW_TEXT, validSpec } from "./fixtures";

describe("the up-front estimate (cap maths)", () => {
  it("matches the hand-worked example: 3 personas × 8 steps on haiku = 83 credits", () => {
    const e = estimateRun("claude-haiku-4-5", 3, 8);
    assert.deepEqual(e.perCall, { step: 1, judge: 1, verdict: 2, fix: 1 });
    assert.equal(e.perPersona, 26);
    assert.equal(e.total, 83);
    assert.equal(e.formula, "3 personas × (8 steps × (1 + 2 × 1) + 2) + 5 × 1 = 83 credits");
  });

  it("clamps the step cap to 2–15 (default 8)", () => {
    assert.deepEqual([clampStepCap(1), clampStepCap(99), clampStepCap("x"), clampStepCap(6)], [2, 15, 8, 6]);
  });

  it("a derivation estimate grows with the interviews' length", () => {
    const short = estimateDerivation("claude-haiku-4-5", [1_000]).total;
    const long = estimateDerivation("claude-haiku-4-5", [200_000]).total;
    assert.ok(long > short);
    assert.equal(estimateDerivation("claude-haiku-4-5", [1_000, 1_000]).total, 2 * short);
  });
});

describe("parallel caps (Phase 16 style)", () => {
  it("PANEL_MAX_PARALLEL_PERSONAS is bounded 1–6 and never above the browser slots", () => {
    assert.equal(panelLimits({}).maxParallelPerRun, 3);
    assert.equal(panelLimits({ PANEL_MAX_PARALLEL_PERSONAS: "50" }).maxParallelPerRun, 6);
    assert.equal(panelLimits({ PANEL_MAX_PARALLEL_PERSONAS: "4" }, 1).maxParallelPerRun, 1);
  });

  it("runPool never runs more than its limit at once and keeps input order", async () => {
    let live = 0;
    let peak = 0;
    const out = await runPool([30, 10, 20, 5, 15], 2, async (ms, i) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, ms));
      live -= 1;
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4]);
    assert.equal(peak, 2);
  });
});

describe("the FAKE model (labelled; tests and smoke only)", () => {
  it("is refused in production even when switched on", () => {
    assert.equal(fakeModelAllowed({ PANEL_FAKE_MODEL: "1", NODE_ENV: "development" }), true);
    assert.equal(fakeModelAllowed({ PANEL_FAKE_MODEL: "1", NODE_ENV: "production" }), false);
    assert.equal(fakeModelAllowed({ NODE_ENV: "development" }), false);
  });

  it("runs the whole pipeline: interviews → personas → walks → a distribution with traced quotes", async () => {
    const store = new InMemoryMemoryStore();
    const ledger = new PanelLedger();
    ledger.beginRun("pipe", 10_000);
    const model = new RouterPanelModel(createFakePanelProvider(), FAKE_MODEL_PRICED_AS, ledger, { kind: "fake" });
    await store.addTranscript({ id: "t-priya", text: INTERVIEW_TEXT, interviewee: "Priya Nair", createdAt: Date.now() });
    await store.addTranscript({
      id: "t-sam",
      text: "Interviewer: What matters to you?\nSam Ortiz: I'm the founder of a two-person studio and I pay with my own money. I can never go above $30 a month. Annual billing is a non-starter for me because cash flow is tight.",
      interviewee: "Sam Ortiz",
      createdAt: Date.now(),
    });
    const personas = [];
    for (const id of ["t-priya", "t-sam"]) {
      await runReflections({ model, store, transcriptId: id, runId: "pipe" });
      personas.push({ key: id.replace("t-", "p-"), spec: (await derivePersonaSpec({ model, store, transcriptId: id, runId: "pipe" })).spec });
    }
    // A hand-made persona with no interview: it walks, but gets no verdict.
    personas.push({ key: "p-manual", spec: validSpec({ identity: { name: "Manual Mo", role: "Buyer" }, sourceTranscriptIds: [] }) });

    const outcomes = [];
    const timelines = [];
    for (const p of personas) {
      const result = await runWalkthrough({
        model,
        store,
        personaSpec: p.spec,
        personaKey: p.key,
        page: new FakeWalkPage(),
        runId: "pipe",
        stepCap: 6,
        humanTiming: false,
        onStepHooks: [personaAdherenceHook({ model, personaSpec: p.spec, runId: "pipe" }), selfConsistencyHook({ model, runId: "pipe" })],
      });
      const timeline = buildTimeline(result);
      timelines.push(timeline);
      outcomes.push(await verdictOrWithheld({ model, store, personaSpec: p.spec, result, timeline, runId: "pipe" }));
    }
    const report = await aggregateReport({ outcomes, timelines, model, runId: "pipe" });

    // Priya ($100 budget, not a hard cap) can afford $49 and tries the signup;
    // Sam ($30 hard cap) bounces at the pricing section.
    assert.deepEqual(report.distribution, { buy: ["Priya Nair"], "no-buy": ["Sam Ortiz"], maybe: [] });
    assert.deepEqual(report.withheld.map((w) => [w.personaName, w.reason]), [["Manual Mo", "no_calibration"]]);
    assert.ok(report.rankedObjections.length >= 1);
    const traced = report.rankedObjections.flatMap((c) => c.interviewQuotes);
    assert.ok(traced.some((q) => q.transcriptId === "t-sam"), "Sam's objection traces to Sam's interview");
    assert.ok(ledger.spend("pipe").spentCredits > 0);
    assert.ok(ledger.spend("pipe").spentCredits <= 10_000);
  });
});
