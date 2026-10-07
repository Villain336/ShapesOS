// Phase 19B (WS=engine) — headless performance: 500 residents × 7 sim-days
// of rules-only ticking (no model) on the medium town, events and hourly
// snapshots recorded, within a stated budget. The measured time is printed
// (the report quotes it).

import { it } from "node:test";
import assert from "node:assert/strict";
import { generateTown } from "../generate";
import { generateResidents } from "../residents";
import { runTown } from "../engine";
import { RulesDecider } from "../decisions";
import { ScenarioSchema } from "../scenario";

/** Budget on this box (2 vCPU class); the measured number is well under it. */
const BUDGET_MS = 15_000;

it(`500 residents × 7 sim-days of rules-only ticking finishes within ${BUDGET_MS / 1000} s`, async () => {
  const town = generateTown({ seed: 2, size: "medium" });
  const residents = generateResidents({ layout: town, population: 500, segments: [], personas: [], seed: 3 });
  const scenario = ScenarioSchema.parse({
    label: "A",
    product: { name: "Trail mix", category: "snacks", priceCents: 900 },
    interventions: [
      { kind: "ad_campaign", channel: "social", startDay: 0, endDay: 6, dailyBudgetCents: 10_000, creative: "New trail mix downtown" },
      { kind: "ad_campaign", channel: "billboard", startDay: 0, endDay: 6, dailyBudgetCents: 20_000, creative: "Trail mix — now downtown" },
      { kind: "promotion", day: 4, endDay: 5, discountPct: 20, label: "Weekend launch", event: true },
    ],
  });
  const t0 = performance.now();
  const run = await runTown({ runId: "perf", layout: town, residents, scenario, days: 7, seed: 9, decider: new RulesDecider() });
  const ms = Math.round(performance.now() - t0);
  console.log(`[perf] 500 residents × 7 sim-days (10,080 ticks): ${ms} ms — ${run.events.length} events, ${run.snapshots.length} snapshots, ${run.decisions.rules} rule decisions`);
  assert.equal(run.days.length, 7);
  assert.equal(run.snapshots.length, 7 * 24);
  assert.ok(ms < BUDGET_MS, `${ms} ms`);
});
