// ShapesOS — Phase 19B (WS=engine): N seeded runs of scenario A (and B)
// under ONE hard credit cap.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// Order: seed 0 → A then B, seed 1 → A then B, … so a cap stop always leaves
// complete A/B pairs behind it. A and B with the same seed index share the
// seed (common random numbers: the difference between them is the
// intervention, not the dice). All sub-runs share one decider — one ledger
// (the cap) and one decision cache (what A already asked, B doesn't pay for
// again while their states agree). The first cap stop ends the whole run:
// the stopped sub-run keeps everything up to that minute, the rest are
// "not_run", and the caller reports exactly where it stopped.

import type { TownDecider } from "./decisions";
import { runTown, type TownEvent, type TownRunResult, type TownStop } from "./engine";
import type { TownLayout } from "./layout";
import type { PersonaSeed, Resident } from "./residents";
import type { Scenario } from "./scenario";

export type Variant = "A" | "B";

export interface SubRun {
  variant: Variant;
  seedIndex: number;
  seed: number;
  status: "completed" | "stopped" | "not_run";
  result: TownRunResult | null;
}

export interface RunScenariosInput {
  runId: string;
  layout: TownLayout;
  residents: Resident[];
  personas?: ReadonlyArray<PersonaSeed>;
  scenarios: { A: Scenario; B?: Scenario | null };
  days: number;
  seeds: number;
  baseSeed: number;
  decider: TownDecider;
  /** What to keep per sub-run (default: everything). */
  record?: (variant: Variant, seedIndex: number) => { events?: boolean; snapshots?: boolean };
  onEvent?: (variant: Variant, seedIndex: number, e: TownEvent) => void;
  onSubRun?: (sub: SubRun) => Promise<void> | void;
  onDay?: (variant: Variant, seedIndex: number, day: number) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface RunScenariosResult {
  subRuns: SubRun[];
  stopped: (TownStop & { variant: Variant; seedIndex: number }) | null;
}

/** The seed of sub-run `i` (shared by A and B). */
export function seedFor(baseSeed: number, seedIndex: number): number {
  return (baseSeed + seedIndex * 7_919) >>> 0;
}

export async function runScenarios(input: RunScenariosInput): Promise<RunScenariosResult> {
  const variants: Variant[] = input.scenarios.B ? ["A", "B"] : ["A"];
  const subRuns: SubRun[] = [];
  for (let i = 0; i < input.seeds; i++) for (const v of variants) subRuns.push({ variant: v, seedIndex: i, seed: seedFor(input.baseSeed, i), status: "not_run", result: null });
  let stopped: RunScenariosResult["stopped"] = null;
  for (const sub of subRuns) {
    if (stopped) break;
    const result = await runTown({
      runId: input.runId,
      layout: input.layout,
      residents: input.residents,
      personas: input.personas,
      scenario: sub.variant === "A" ? input.scenarios.A : input.scenarios.B!,
      days: input.days,
      seed: sub.seed,
      decider: input.decider,
      record: input.record?.(sub.variant, sub.seedIndex),
      onEvent: input.onEvent ? (e) => input.onEvent!(sub.variant, sub.seedIndex, e) : undefined,
      onDay: input.onDay ? (d) => input.onDay!(sub.variant, sub.seedIndex, d) : undefined,
      signal: input.signal,
    });
    sub.result = result;
    sub.status = result.stopped ? "stopped" : "completed";
    if (result.stopped) stopped = { ...result.stopped, variant: sub.variant, seedIndex: sub.seedIndex };
    await input.onSubRun?.(sub);
  }
  return { subRuns, stopped };
}
