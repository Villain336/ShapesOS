// ShapesOS — Phase 19B (WS=engine): the up-front cost estimate of a town run
// — shown to the person and confirmed BEFORE anything is queued.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// Two numbers, both in ShapesOS credits priced by the router's own tables
// (the panel's worstCaseCallCredits / creditsForUsage, lib/panel/budget.ts):
//
//   cap (upper bound)  residents × days × 6 capped decisions a day
//                      (DAILY_DECISION_CAP: ad 2, enter 1, mention 1,
//                      purchase 1, reflect 1) × seeds × scenarios
//                      × the worst case of one call (DECISION_PROMPT_CHARS
//                      in, the point's maxTokens out). The engine never asks
//                      more than this, so this cap can't stop a run that
//                      behaves — the person may confirm a lower one.
//   expected           a FREE rules-only dry run of seed 0 of each scenario
//                      (no model): the decisions that would reach the model,
//                      de-duplicated the way the decision cache would, × seeds,
//                      × a typical call (TYPICAL_PROMPT_CHARS in, TYPICAL_OUTPUT
//                      tokens out). Rules and a model don't decide alike, so
//                      this is an estimate (tested within ±35 % of the fake
//                      model's actual calls), never a promise.
// A schema retry is a second call: rare, and still under the hard cap (the
// run stops cleanly at the cap whatever the estimate said).

import { creditsForUsage, CHARS_PER_TOKEN, worstCaseCallCredits } from "@/lib/panel/budget";
import { DAILY_DECISION_CAP, DECISION_MAX_TOKENS, DECISION_POINTS, DECISION_PROMPT_CHARS, RulesDecider, type Decision, type DecisionRequest, type TownDecider } from "./decisions";
import type { TownLayout } from "./layout";
import type { PersonaSeed, Resident } from "./residents";
import { runScenarios } from "./runner";
import type { Scenario } from "./scenario";

/** A typical decision prompt and answer (measured on the fake model: ~1.5k chars in, ~40 tokens out). */
export const TYPICAL_PROMPT_CHARS = 1_800;
export const TYPICAL_OUTPUT_TOKENS = 80;

export interface TownEstimateInput {
  layout: TownLayout;
  residents: Resident[];
  personas?: ReadonlyArray<PersonaSeed>;
  scenarios: { A: Scenario; B?: Scenario | null };
  days: number;
  seeds: number;
  baseSeed: number;
  /** The model the run is priced on. */
  model: string;
}

export interface TownEstimate {
  model: string;
  scenarios: number;
  seeds: number;
  residentDays: number;
  maxCalls: number;
  worstCreditsPerCall: number;
  /** Suggested hard cap = maxCalls × worstCreditsPerCall. */
  capCredits: number;
  expectedCalls: number;
  typicalCreditsPerCall: number;
  expectedCredits: number;
  perResidentDay: { maxCalls: number; expectedCalls: number };
}

/** Counts what would reach the model (keys de-duplicated like the cache), answering with rules. */
class CountingRulesDecider implements TownDecider {
  readonly kind = "rules" as const;
  readonly keys = new Set<string>();
  private readonly rules = new RulesDecider();
  async decideMany(runId: string, reqs: DecisionRequest[]): Promise<Decision[]> {
    for (const r of reqs) this.keys.add(r.key);
    return this.rules.decideMany(runId, reqs);
  }
}

export async function estimateTownRun(input: TownEstimateInput): Promise<TownEstimate> {
  const scenarios = input.scenarios.B ? 2 : 1;
  const seeds = Math.max(1, Math.floor(input.seeds));
  const days = Math.max(1, Math.floor(input.days));
  const residentDays = input.residents.length * days;
  const perDayCap = DECISION_POINTS.reduce((n, p) => n + DAILY_DECISION_CAP[p], 0);
  const maxCalls = residentDays * perDayCap * seeds * scenarios;
  const worstCreditsPerCall = Math.max(...DECISION_POINTS.map((p) => worstCaseCallCredits(input.model, DECISION_PROMPT_CHARS, DECISION_MAX_TOKENS[p])));
  const counter = new CountingRulesDecider();
  await runScenarios({ runId: "estimate", layout: input.layout, residents: input.residents, personas: input.personas, scenarios: input.scenarios, days, seeds: 1, baseSeed: input.baseSeed, decider: counter, record: () => ({ events: false, snapshots: false }) });
  const expectedCalls = Math.min(maxCalls, counter.keys.size * seeds);
  const typicalCreditsPerCall = creditsForUsage(input.model, { inputTokens: Math.ceil(TYPICAL_PROMPT_CHARS / CHARS_PER_TOKEN), outputTokens: TYPICAL_OUTPUT_TOKENS });
  return {
    model: input.model,
    scenarios,
    seeds,
    residentDays,
    maxCalls,
    worstCreditsPerCall,
    capCredits: maxCalls * worstCreditsPerCall,
    expectedCalls,
    typicalCreditsPerCall,
    expectedCredits: expectedCalls * typicalCreditsPerCall,
    perResidentDay: { maxCalls: perDayCap, expectedCalls: Math.round((expectedCalls / (residentDays * seeds * scenarios)) * 100) / 100 },
  };
}
