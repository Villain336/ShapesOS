// Phase 19B (WS=engine) — the tick loop: residents follow their routine,
// the same seed + the same inputs give the same event log byte for byte,
// and money balances for every resident on every day.
// Decisions use the labelled FAKE town model (deterministic; no AI model is
// called) or the rules decider.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateTown } from "../generate";
import { generateResidents, minuteOf } from "../residents";
import { runTown } from "../engine";
import { hashEvents } from "../hash";
import { RulesDecider, ModelDecider, DecisionCache } from "../decisions";
import { fakeTownModel } from "../fake-model";
import { PanelLedger } from "@/lib/panel/budget";
import { ScenarioSchema } from "../scenario";
import { validSpec } from "../../panel/__tests__/fixtures";

const town = generateTown({ seed: 5, size: "small" });
const persona = { id: "p1", spec: validSpec(), calibrated: true };
const residents = generateResidents({
  layout: town,
  population: 50,
  segments: [
    { key: "buyers", label: "Buyers", share: 0.5, personaId: "p1", routineMix: { weekday: 1 } },
    { key: "mixed", label: "Mixed", share: 0.5 },
  ],
  personas: [persona],
  seed: 21,
});
const scenario = ScenarioSchema.parse({
  label: "A",
  product: { name: "Trail mix", category: "snacks", priceCents: 900, description: "Small-batch trail mix" },
  interventions: [{ kind: "ad_campaign", channel: "social", startDay: 0, endDay: 6, dailyBudgetCents: 2_000, creative: "New trail mix downtown — try a free sample" }],
});

function fakeDecider(runId = "run-1") {
  const ledger = new PanelLedger();
  ledger.beginRun(runId, 1_000_000);
  return new ModelDecider(fakeTownModel(ledger), new DecisionCache());
}

describe("routine in the running town", () => {
  it("a weekday resident is at their workplace at 11:00 on a weekday, and at home at 03:00", async () => {
    const run = await runTown({ runId: "run-1", layout: town, residents, scenario, days: 3, seed: 1, decider: new RulesDecider() });
    const r = residents.find((x) => x.routine === "weekday")!;
    const at = (t: number) => run.snapshots.find((s) => s.t === t)!.residents.find((x) => x.id === r.id)!;
    assert.equal(at(minuteOf(2, 11)).lot, r.workLotId, "Wednesday 11:00");
    assert.equal(at(minuteOf(2, 3)).lot, r.homeLotId, "Wednesday 03:00");
  });
});

describe("determinism", () => {
  it("the same seed and inputs give an identical event log hash (fake model)", async () => {
    const a = await runTown({ runId: "run-1", layout: town, residents, scenario, days: 3, seed: 42, decider: fakeDecider() });
    const b = await runTown({ runId: "run-1", layout: town, residents, scenario, days: 3, seed: 42, decider: fakeDecider() });
    assert.ok(a.events.length > 500, `${a.events.length} events`);
    assert.ok(a.events.some((e) => e.type === "decision"), "the model was asked at decision points");
    assert.equal(hashEvents(a.events), hashEvents(b.events));
  });

  it("a different seed gives a different log", async () => {
    const a = await runTown({ runId: "run-1", layout: town, residents, scenario, days: 2, seed: 42, decider: new RulesDecider() });
    const b = await runTown({ runId: "run-1", layout: town, residents, scenario, days: 2, seed: 43, decider: new RulesDecider() });
    assert.notEqual(hashEvents(a.events), hashEvents(b.events));
  });

  it("decision events only ever come from the five decision points", async () => {
    const a = await runTown({ runId: "run-1", layout: town, residents, scenario, days: 3, seed: 7, decider: fakeDecider() });
    const points = new Set(a.events.filter((e) => e.type === "decision").map((e) => (e.d as { point: string }).point));
    for (const p of points) assert.ok(["ad", "enter", "mention", "purchase", "reflect"].includes(p), p);
  });
});

describe("economy", () => {
  it("money in = money out + balances, for every resident, every day, over 30 sim-days", async () => {
    const run = await runTown({ runId: "run-1", layout: town, residents, scenario: { ...scenario, interventions: [...scenario.interventions, { kind: "promotion", day: 3, endDay: 5, discountPct: 20, label: "Launch week", event: true }] }, days: 30, seed: 9, decider: new RulesDecider(), record: { events: false, snapshots: false } });
    assert.equal(run.ledger.length, residents.length * 30);
    for (const row of run.ledger) {
      assert.equal(row.opening + row.wagesIn, row.rentOut + row.purchasesOut + row.closing, `${row.residentId} day ${row.day}`);
    }
    // Day to day the closing balance carries over.
    const byRes = new Map<string, typeof run.ledger>();
    for (const row of run.ledger) byRes.set(row.residentId, [...(byRes.get(row.residentId) ?? []), row]);
    for (const rows of byRes.values()) for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.opening, rows[i - 1]!.closing);
    // Every purchase is a store's revenue.
    const spent = run.ledger.reduce((s, r) => s + r.purchasesOut, 0);
    const earned = Object.values(run.storeRevenueCents).reduce((s, v) => s + v, 0);
    assert.ok(spent > 0, "people bought things");
    assert.equal(spent, earned);
    assert.ok(run.ledger.some((r) => r.wagesIn > 0) && run.ledger.some((r) => r.rentOut > 0));
  });
});

describe("the event fingerprint", () => {
  it("is canonical: the same event with keys in another order (a JSONB round trip) hashes the same", () => {
    const a = { seq: 1, t: 5, type: "decision" as const, r: "r001", d: { point: "reflect", key: "k", value: { summary: "A day.", plan: "nothing" } } };
    const b = { seq: 1, t: 5, type: "decision" as const, r: "r001", d: { key: "k", point: "reflect", value: { plan: "nothing", summary: "A day." } } };
    assert.equal(hashEvents([a]), hashEvents([b]));
  });

  it("ignores who answered (model or cache) but not what was answered", () => {
    const base = { seq: 1, t: 5, type: "decision" as const, r: "r001", d: { point: "ad", key: "k", value: { attention: "curious", thought: "Hm." } } };
    assert.equal(hashEvents([{ ...base, d: { ...base.d, source: "model", credits: 1 } }]), hashEvents([{ ...base, d: { ...base.d, source: "cache" } }]));
    assert.notEqual(hashEvents([base]), hashEvents([{ ...base, d: { ...base.d, value: { attention: "ignore", thought: "Hm." } } }]));
  });
});
