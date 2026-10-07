// ShapesOS — Phase 19B (WS=engine): town results — honest by construction.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
//   * every curve is a RANGE over the N seeded runs (min, quartiles, median,
//     max, mean, sd) — never a single number;
//   * A vs B is compared PAIRED by seed (same dice, different intervention),
//     with the Test Lab's power badge (lib/flywheel/testlab/honesty.ts
//     powerBadge: the detectable lift for this many residents vs the lift
//     seen). Underpowered → inconclusive; seeds that disagree on the sign →
//     inconclusive; fewer than 3 seeds → underpowered;
//   * "no calibration data → no verdict" (the panel's rule, enforced here
//     too): without at least one real launch in the workspace's track record
//     (panel_calibrations) AND calibrated residents, the ranges show and the
//     verdict is withheld.
// Synthetic, labelled synthetic, and never representative.

import { powerBadge, type HonestyInput } from "@/lib/flywheel/testlab/honesty";

export const NOT_REPRESENTATIVE =
  "Synthetic town. Not representative: residents are simulated from your personas and sliders, so these are directional ranges across seeded runs, never a forecast.";
export const MIN_SEEDS_FOR_VERDICT = 3;

export interface Range {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
  /** Sample standard deviation (0 for one seed). */
  sd: number;
  n: number;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function rangeOf(values: readonly number[]): Range {
  if (values.length === 0) throw new Error("A range needs at least one seed.");
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { min: s[0]!, p25: quantile(s, 0.25), median: quantile(s, 0.5), p75: quantile(s, 0.75), max: s[n - 1]!, mean, sd, n };
}

/** perSeed[seed][day] → one range per day (a seed counts for the days it ran). */
export function seriesRanges(perSeed: ReadonlyArray<readonly number[]>): Range[] {
  const days = Math.max(0, ...perSeed.map((s) => s.length));
  const out: Range[] = [];
  for (let d = 0; d < days; d++) {
    const vals = perSeed.filter((s) => s.length > d).map((s) => s[d]!);
    if (vals.length) out.push(rangeOf(vals));
  }
  return out;
}

export interface CalibrationState {
  /** Real launches entered against panel runs (panel_calibrations rows). */
  launches: number;
  /** Mean absolute error over them (lib/panel/validator.ts calibrationScore); null with none. */
  score: number | null;
}

export type ComparisonVerdict = "b_ahead" | "a_ahead" | "inconclusive";

export interface VariantComparison {
  metric: "adoption";
  /** B − A per seed (paired). */
  difference: Range;
  relativeLift: number;
  badges: { power: "powered" | "underpowered"; powerDetail: string; seeds: number };
  /** null when withheld. */
  verdict: ComparisonVerdict | null;
  withheld: "no_calibration" | null;
  explanation: string;
}

export interface CompareInput {
  /** Final adoption rate per seed, scenario A and B (same seed order). */
  a: readonly number[];
  b: readonly number[];
  residents: number;
  calibration: CalibrationState;
  calibratedResidents: number;
}

export function compareVariants(input: CompareInput): VariantComparison {
  const n = Math.min(input.a.length, input.b.length);
  const diffs = Array.from({ length: n }, (_, i) => input.b[i]! - input.a[i]!);
  const difference = rangeOf(diffs.length ? diffs : [0]);
  const meanA = n ? input.a.slice(0, n).reduce((s, x) => s + x, 0) / n : 0;
  const meanB = n ? input.b.slice(0, n).reduce((s, x) => s + x, 0) / n : 0;
  const relativeLift = meanA > 0 ? (meanB - meanA) / meanA : meanB > 0 ? 1 : 0;
  const honesty: HonestyInput = {
    metricType: "binomial",
    armA: { successes: Math.round(meanA * input.residents), trials: input.residents },
    armB: { successes: Math.round(meanB * input.residents), trials: input.residents },
    statedMde: Math.max(0.01, Math.abs(relativeLift)),
    minRuntimeDays: 7,
    daysRunning: 7,
    fullCycleCovered: true,
    guardrails: [],
    expectedLossThreshold: 0.005,
    minUnits: 0,
    conversionTest: false,
  };
  const pb = powerBadge(honesty);
  const power = n < MIN_SEEDS_FOR_VERDICT ? "underpowered" : pb.label;
  const powerDetail = n < MIN_SEEDS_FOR_VERDICT ? `Only ${n} seeded run${n === 1 ? "" : "s"}: at least ${MIN_SEEDS_FOR_VERDICT} are needed to see seed variance.` : pb.detail;
  const consistent = difference.min > 0 ? "b_ahead" : difference.max < 0 ? "a_ahead" : null;
  const verdict: ComparisonVerdict = power === "underpowered" || !consistent ? "inconclusive" : consistent;
  const uncalibrated = input.calibration.launches === 0 || input.calibratedResidents === 0;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const explanation = uncalibrated
    ? input.calibration.launches === 0
      ? "No verdict: there is no calibration data yet. Enter a real launch result on a page-walk run to calibrate; until then the town shows ranges only."
      : "No verdict: none of these residents comes from a calibrated persona (one that cites an interview)."
    : verdict === "inconclusive"
      ? `Inconclusive: ${power === "underpowered" ? powerDetail : "the seeded runs disagree on which scenario does better."}`
      : `${verdict === "b_ahead" ? "B" : "A"} adopted more in every seeded run (difference ${pct(difference.min)} to ${pct(difference.max)}). Synthetic and directional.`;
  return { metric: "adoption", difference, relativeLift, badges: { power, powerDetail, seeds: n }, verdict: uncalibrated ? null : verdict, withheld: uncalibrated ? "no_calibration" : null, explanation };
}
