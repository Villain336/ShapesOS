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
import { FAKE_MODEL_LABEL } from "@/lib/panel/fake-model";
import { traceToInterviews, type InterviewTrace } from "@/lib/panel/trace";
import type { DayMetrics, TownStop } from "./engine";
import type { PersonaSeed, Resident, SegmentSpec } from "./residents";
import type { SubRun, Variant } from "./runner";
import { describeIntervention, type Scenario } from "./scenario";

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

// ---------------------------------------------------------------------------
// The town report (what the results view, the export and the agent read)
// ---------------------------------------------------------------------------


export interface SegmentResult {
  segment: string;
  label: string;
  residents: number;
  calibrated: boolean;
  adoption: Range;
  visits: Range;
}

export interface ObjectionResult {
  day: number;
  text: string;
  /** How many times it was said, across all seeds. */
  count: number;
  segments: string[];
  /** The interview words behind it, or null (untraced — not from an interview). */
  trace: InterviewTrace | null;
}

export type KeyMomentKind = "intervention" | "first_ad" | "first_visit" | "first_adoption" | "first_mention" | "peak_visits" | "cap_stop";

export interface KeyMoment {
  kind: KeyMomentKind;
  t: number;
  day: number;
  label: string;
}

export interface VariantReport {
  variant: Variant;
  label: string;
  interventions: string[];
  seedsCompleted: number;
  seedsStopped: number;
  residents: number;
  /** Cumulative share of residents who bought, per day. */
  adoption: Range[];
  footTraffic: Range[];
  revenueCents: Range[];
  units: Range[];
  finalAdoption: Range;
  totalRevenueCents: Range;
  bySegment: SegmentResult[];
  objections: ObjectionResult[];
  keyMoments: KeyMoment[];
}

export interface TownReport {
  synthetic: true;
  banner: string;
  modelKind: "live" | "fake" | "rules";
  modelLabel: string;
  days: number;
  variants: { A: VariantReport; B?: VariantReport };
  comparison: VariantComparison | null;
  calibration: CalibrationState;
  /** Sample sd of final adoption across seeds (seed variance, shown). */
  seedVariance: { A: number; B?: number };
  stopped: (TownStop & { variant: Variant; seedIndex: number }) | null;
}

export interface BuildReportInput {
  scenarios: { A: Scenario; B?: Scenario | null };
  subRuns: SubRun[];
  stopped: TownReport["stopped"];
  residents: Resident[];
  segments: SegmentSpec[];
  personas: ReadonlyArray<PersonaSeed>;
  calibration: CalibrationState;
  /** Interview chunks of each persona's own transcripts (quote tracing). */
  interviewChunks: ReadonlyMap<string, ReadonlyArray<{ transcriptId: string; content: string }>>;
  modelKind: "live" | "fake" | "rules";
  days: number;
}

const MODEL_LABELS = { live: "AI model at decision points (through the ShapesOS router)", fake: FAKE_MODEL_LABEL, rules: "Rules only (no AI model was called)" } as const;

function variantReport(v: Variant, scenario: Scenario, input: BuildReportInput): VariantReport {
  const runs = input.subRuns.filter((s) => s.variant === v && s.result && s.result.days.length > 0);
  const pop = Math.max(1, input.residents.length);
  const perSeed = (f: (d: DayMetrics) => number) => runs.map((s) => s.result!.days.map(f));
  const segLabels = new Map(input.segments.map((s) => [s.key, s.label]));
  const segKeys = [...new Set(input.residents.map((r) => r.segment))].sort();
  const bySegment: SegmentResult[] = runs.length
    ? segKeys.map((seg) => {
        const members = input.residents.filter((r) => r.segment === seg);
        return {
          segment: seg,
          label: segLabels.get(seg) ?? seg,
          residents: members.length,
          calibrated: members.some((r) => r.calibrated),
          adoption: rangeOf(runs.map((s) => (s.result!.days.at(-1)!.bySegment[seg]?.adopters ?? 0) / Math.max(1, members.length))),
          visits: rangeOf(runs.map((s) => s.result!.days.reduce((n, d) => n + (d.bySegment[seg]?.visits ?? 0), 0))),
        };
      })
    : [];
  const residentsById = new Map(input.residents.map((r) => [r.id, r]));
  const grouped = new Map<string, ObjectionResult>();
  for (const s of runs) {
    for (const o of s.result!.objections) {
      const k = `${o.day}|${o.text}`;
      const g = grouped.get(k);
      if (g) {
        g.count += 1;
        if (!g.segments.includes(o.segment)) g.segments.push(o.segment);
        continue;
      }
      const persona = o.personaId ?? residentsById.get(o.residentId)?.personaId ?? null;
      const chunks = persona ? (input.interviewChunks.get(persona) ?? []) : [];
      grouped.set(k, { day: o.day, text: o.text, count: 1, segments: [o.segment], trace: chunks.length ? traceToInterviews(o.text, chunks) : null });
    }
  }
  const objections = [...grouped.values()].sort((a, b) => a.day - b.day || b.count - a.count || a.text.localeCompare(b.text));
  const keyMoments: KeyMoment[] = [];
  const first = runs.find((s) => s.seedIndex === 0) ?? runs[0];
  if (first?.result) {
    const ev = first.result.events;
    const at = (t: number) => Math.floor(t / 1440);
    for (const e of ev) if (e.type === "intervention") keyMoments.push({ kind: "intervention", t: e.t, day: at(e.t), label: describeIntervention(e.d as never) });
    const firstOf = (type: string, kind: KeyMomentKind, label: string) => {
      const e = ev.find((x) => x.type === type);
      if (e) keyMoments.push({ kind, t: e.t, day: at(e.t), label });
    };
    firstOf("ad", "first_ad", "First resident sees an ad");
    firstOf("visit", "first_visit", "First visit to your store");
    firstOf("adopt", "first_adoption", "First purchase");
    firstOf("mention", "first_mention", "First word of mouth");
    firstOf("cap_stop", "cap_stop", "Stopped at the credit cap");
    const peak = [...first.result.days].sort((a, b) => b.visits - a.visits || a.day - b.day)[0];
    if (peak && peak.visits > 0) keyMoments.push({ kind: "peak_visits", t: peak.day * 1440 + 12 * 60, day: peak.day, label: `Busiest day: ${peak.visits} visits` });
    keyMoments.sort((a, b) => a.t - b.t);
  }
  const finals = runs.map((s) => s.result!.days.at(-1)!.adoptersCumulative / pop);
  return {
    variant: v,
    label: scenario.label,
    interventions: scenario.interventions.map((i) => describeIntervention(i)),
    seedsCompleted: runs.filter((s) => s.status === "completed").length,
    seedsStopped: runs.filter((s) => s.status === "stopped").length,
    residents: input.residents.length,
    adoption: seriesRanges(perSeed((d) => d.adoptersCumulative / pop)),
    footTraffic: seriesRanges(perSeed((d) => d.visits)),
    revenueCents: seriesRanges(perSeed((d) => d.revenueCents)),
    units: seriesRanges(perSeed((d) => d.units)),
    finalAdoption: rangeOf(finals.length ? finals : [0]),
    totalRevenueCents: rangeOf(runs.length ? runs.map((s) => s.result!.days.reduce((n, d) => n + d.revenueCents, 0)) : [0]),
    bySegment,
    objections,
    keyMoments,
  };
}

/** The whole report: ranges, segments, objections (traced), key moments, A vs B. */
export function buildTownReport(input: BuildReportInput): TownReport {
  const A = variantReport("A", input.scenarios.A, input);
  const B = input.scenarios.B ? variantReport("B", input.scenarios.B, input) : undefined;
  let comparison: VariantComparison | null = null;
  if (B) {
    // Paired by seed: only seeds where both A and B ran.
    const pop = Math.max(1, input.residents.length);
    const final = (v: Variant) => new Map(input.subRuns.filter((s) => s.variant === v && s.result?.days.length).map((s) => [s.seedIndex, s.result!.days.at(-1)!.adoptersCumulative / pop]));
    const fa = final("A");
    const fb = final("B");
    const both = [...fa.keys()].filter((k) => fb.has(k)).sort((x, y) => x - y);
    comparison = compareVariants({ a: both.map((k) => fa.get(k)!), b: both.map((k) => fb.get(k)!), residents: input.residents.length, calibration: input.calibration, calibratedResidents: input.residents.filter((r) => r.calibrated).length });
  }
  return {
    synthetic: true,
    banner: NOT_REPRESENTATIVE,
    modelKind: input.modelKind,
    modelLabel: MODEL_LABELS[input.modelKind],
    days: input.days,
    variants: { A, ...(B ? { B } : {}) },
    comparison,
    calibration: input.calibration,
    seedVariance: { A: A.finalAdoption.sd, ...(B ? { B: B.finalAdoption.sd } : {}) },
    stopped: input.stopped,
  };
}
