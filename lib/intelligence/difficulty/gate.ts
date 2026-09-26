// Marketr — Phase 10 M5: the eval bar and the vendor-replacement gate.
//
// THE EVAL BAR (the bar the model must clear before it replaces the vendor
// difficulty call in any user-facing path — §M5):
//
//   On a held-out set of ≥ 50 keywords spanning the difficulty deciles,
//   with DataForSEO `labs/bulk_keyword_difficulty` ($0.132/1K) as the paid
//   reference, the model PASSES only if ALL of these hold:
//
//     1. MAE ≤ 15 .......... mean absolute error vs. the vendor reference,
//                             on the 0–100 scale ("within 15% of vendor").
//     2. Spearman ρ ≥ 0.70 .. the model's RANKING of keywords must track the
//                             vendor's. Ordering is what keyword research UX
//                             actually shows; a right-on-average model that
//                             misorders is worse than useless.
//     3. Band coverage ≥ 70%  at least 70% of vendor references must fall
//                             inside the model's uncertainty band. The band
//                             is the honest-attribution contract (§M5: the
//                             model carries uncertainty to the UI) — a model
//                             that is precise but miscalibrated fails.
//
// Gate state lives in eval-state.json (versioned, next to this file).
// M7's verification battery runs scripts/eval-difficulty.mts --live, which
// writes eval-state.json with --write-state. shouldReplaceVendor() returns
// true ONLY when the last recorded eval PASSED for the CURRENT model
// version. A model bump automatically closes the gate until re-evaluated.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_VERSION } from "./model";

export const EVAL_BAR = {
  minKeywords: 50,
  maxMAE: 15,
  minSpearman: 0.7,
  minBandCoverage: 0.7,
} as const;

export interface EvalMetrics {
  n: number;
  mae: number;
  spearman: number;
  bandCoverage: number;
  vendorReference: "dataforseo_labs_bulk_keyword_difficulty";
}

export interface EvalState {
  modelVersion: string;
  evaluatedAt: string | null;
  passed: boolean;
  metrics: EvalMetrics | null;
  note: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function evalStatePath(): string {
  return join(HERE, "eval-state.json");
}

export function readEvalState(): EvalState {
  try {
    const raw = readFileSync(evalStatePath(), "utf8");
    return JSON.parse(raw) as EvalState;
  } catch {
    return {
      modelVersion: MODEL_VERSION,
      evaluatedAt: null,
      passed: false,
      metrics: null,
      note: "No eval has run yet for this model version.",
    };
  }
}

/**
 * The gate. Until the model passes the bar for the CURRENT model version,
 * every user-facing path uses the vendor difficulty call and the UI shows
 * the modeled value marked EXPERIMENTAL alongside it.
 */
export function shouldReplaceVendor(): boolean {
  const state = readEvalState();
  return (
    state.passed === true &&
    state.modelVersion === MODEL_VERSION &&
    state.metrics != null
  );
}

export function gateStatus(): {
  replaceVendor: boolean;
  experimental: boolean;
  state: EvalState;
} {
  const state = readEvalState();
  const replaceVendor = shouldReplaceVendor();
  return { replaceVendor, experimental: !replaceVendor, state };
}

// ── Pure metric functions (used by the eval script and unit tests) ──────────

export function meanAbsoluteError(pairs: Array<{ modeled: number; reference: number }>): number {
  if (pairs.length === 0) return Number.POSITIVE_INFINITY;
  const sum = pairs.reduce((s, p) => s + Math.abs(p.modeled - p.reference), 0);
  return sum / pairs.length;
}

function rankAverage(values: number[]): number[] {
  // Average ranks for ties (1-based).
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const avg = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[order[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation between modeled and reference orderings. */
export function spearman(pairs: Array<{ modeled: number; reference: number }>): number {
  const n = pairs.length;
  if (n < 2) return Number.NaN;
  const rx = rankAverage(pairs.map((p) => p.modeled));
  const ry = rankAverage(pairs.map((p) => p.reference));
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return Number.NaN;
  return num / Math.sqrt(dx * dy);
}

/** Fraction of references landing inside the model's uncertainty band. */
export function bandCoverage(
  pairs: Array<{ band: [number, number]; reference: number }>,
): number {
  if (pairs.length === 0) return 0;
  const hits = pairs.filter(
    (p) => p.reference >= p.band[0] && p.reference <= p.band[1],
  ).length;
  return hits / pairs.length;
}

export interface BarCheck {
  passed: boolean;
  checks: {
    n: { ok: boolean; value: number; required: string };
    mae: { ok: boolean; value: number; required: string };
    spearman: { ok: boolean; value: number; required: string };
    bandCoverage: { ok: boolean; value: number; required: string };
  };
}

/** Evaluate one full metric set against the bar. */
export function checkBar(
  metrics: { n: number; mae: number; spearman: number; bandCoverage: number },
  bar = EVAL_BAR,
): BarCheck {
  const nOk = metrics.n >= bar.minKeywords;
  const maeOk = Number.isFinite(metrics.mae) && metrics.mae <= bar.maxMAE;
  const spOk = Number.isFinite(metrics.spearman) && metrics.spearman >= bar.minSpearman;
  const bcOk = Number.isFinite(metrics.bandCoverage) && metrics.bandCoverage >= bar.minBandCoverage;
  return {
    passed: nOk && maeOk && spOk && bcOk,
    checks: {
      n: { ok: nOk, value: metrics.n, required: `≥ ${bar.minKeywords}` },
      mae: { ok: maeOk, value: metrics.mae, required: `≤ ${bar.maxMAE}` },
      spearman: { ok: spOk, value: metrics.spearman, required: `≥ ${bar.minSpearman}` },
      bandCoverage: { ok: bcOk, value: metrics.bandCoverage, required: `≥ ${bar.minBandCoverage}` },
    },
  };
}
