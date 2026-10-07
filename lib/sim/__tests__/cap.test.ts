// Phase 19B (WS=engine) — the panel's HARD per-run credit cap on a town run:
// the up-front estimate (a free rules-only dry run) against the actual spend
// of the labelled FAKE model, a clean stop with an honest partial result,
// and N seeded runs (A and B) sharing ONE cap.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PanelLedger } from "@/lib/panel/budget";
import { FAKE_MODEL_PRICED_AS } from "@/lib/panel/fake-model";
import { generateTown } from "../generate";
import { generateResidents } from "../residents";
import { DecisionCache, ModelDecider } from "../decisions";
import { fakeTownModel } from "../fake-model";
import { estimateTownRun } from "../estimate";
import { runScenarios } from "../runner";
import { ScenarioSchema } from "../scenario";
import { validSpec } from "../../panel/__tests__/fixtures";

const town = generateTown({ seed: 5, size: "small" });
const personas = [{ id: "p1", spec: validSpec(), calibrated: true }];
const residents = generateResidents({ layout: town, population: 50, segments: [{ key: "buyers", label: "Buyers", share: 0.6, personaId: "p1" }, { key: "others", label: "Others", share: 0.4 }], personas, seed: 21 });
const A = ScenarioSchema.parse({
  label: "A",
  product: { name: "Trail mix", category: "snacks", priceCents: 900 },
  interventions: [{ kind: "ad_campaign", channel: "social", startDay: 0, endDay: 6, dailyBudgetCents: 1_200, creative: "New trail mix downtown" }],
});
const B = ScenarioSchema.parse({ ...A, label: "B", interventions: [...A.interventions, { kind: "price_change", day: 1, priceCents: 600 }] });
const base = { layout: town, residents, personas, scenarios: { A, B }, days: 3, baseSeed: 100 };

function fakeRun(cap: number) {
  const ledger = new PanelLedger();
  ledger.beginRun("run", cap);
  return { ledger, decider: new ModelDecider(fakeTownModel(ledger), new DecisionCache()) };
}

describe("estimate", () => {
  it("is an upper bound (the cap) plus an expected figure from a free dry run, and the actual spend lands within ±35 % of expected", async () => {
    const est = await estimateTownRun({ ...base, seeds: 2, model: FAKE_MODEL_PRICED_AS });
    assert.ok(est.maxCalls >= est.expectedCalls && est.capCredits >= est.expectedCredits);
    // 50 residents × 3 days × 6 capped decisions × 2 seeds × 2 variants
    assert.equal(est.maxCalls, 3_600);
    const { ledger, decider } = fakeRun(est.capCredits);
    const out = await runScenarios({ ...base, runId: "run", seeds: 2, decider });
    assert.equal(out.stopped, null);
    const actual = ledger.spend("run");
    assert.ok(actual.spentCredits <= est.capCredits, "never past the cap");
    const ratio = actual.callCount / est.expectedCalls;
    assert.ok(ratio > 0.65 && ratio < 1.35, `calls actual ${actual.callCount} vs expected ${est.expectedCalls}`);
    const credRatio = actual.spentCredits / est.expectedCredits;
    assert.ok(credRatio > 0.3 && credRatio <= 1.35, `credits actual ${actual.spentCredits} vs expected ${est.expectedCredits}`);
  });
});

describe("the hard cap", () => {
  it("stops cleanly mid-run with an honest partial: where it stopped, what finished, nothing past the cap", async () => {
    const { ledger, decider } = fakeRun(40);
    const out = await runScenarios({ ...base, runId: "run", seeds: 1, decider });
    assert.ok(out.stopped, "stopped");
    assert.equal(out.stopped!.reason, "cap");
    assert.equal(out.stopped!.variant, "A");
    assert.match(out.stopped!.detail, /Stopped at (Monday|Tuesday|Wednesday) \(day \d\) \d\d:\d\d/);
    const spend = ledger.spend("run");
    assert.ok(spend.spentCredits <= 40);
    // Decisions are asked 4 at a time: every one that couldn't reserve its worst case was refused (never sent).
    assert.ok(spend.refusedCalls >= 1 && spend.refusedCalls <= 4, String(spend.refusedCalls));
    const a = out.subRuns.find((s) => s.variant === "A")!;
    assert.equal(a.status, "stopped");
    assert.ok(a.result!.events.some((e) => e.type === "cap_stop"));
    assert.ok(a.result!.days.length >= 1, "metrics up to the stop are kept");
    assert.equal(out.subRuns.find((s) => s.variant === "B")!.status, "not_run");
  });

  it("N seeded runs share ONE cap: what one seed spends, the next can't", async () => {
    const one = fakeRun(1_000_000);
    await runScenarios({ ...base, scenarios: { A }, runId: "run", seeds: 1, decider: one.decider });
    const perSeed = one.ledger.spend("run").spentCredits;
    const { ledger, decider } = fakeRun(Math.floor(perSeed * 1.5));
    const out = await runScenarios({ ...base, scenarios: { A }, runId: "run", seeds: 3, decider });
    assert.deepEqual(out.subRuns.map((s) => s.status), ["completed", "stopped", "not_run"]);
    assert.ok(ledger.spend("run").spentCredits <= Math.floor(perSeed * 1.5));
  });
});
