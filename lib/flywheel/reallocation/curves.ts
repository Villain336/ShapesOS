// Marketr — Phase 7 F1: diminishing-returns curve fitting.
//
// Marginal-ROAS equalization needs per-channel spend→response curves.
// Three forms (Hill saturation, power, log-log), Robyn-style adstock +
// day-of-week seasonality, fit by deterministic least squares on fixtures.
// The best form wins by R². Marginal ROAS = the curve's derivative at
// current spend — never greedy last-click ranking.
//
// Pure math, no I/O: safe to run in the verify battery and at request time.

import type { AdstockParams, CurveParams, CurveType, DataPoint, MarginalCurve } from "./types";

export const MODEL_VERSION = "f1-curves-v2";

/** Adstock decays tried in a deterministic grid; 0 = instantaneous response. */
export const ADSTOCK_DECAY_GRID = [0, 0.25, 0.5, 0.75] as const;

export interface FitInput {
  workspaceId: string;
  channel: string;
  points: DataPoint[]; // raw, timestamped; adstock + seasonality applied here
  dataWindow: string;
  iroasCalibrationFactor?: number;
  adstock?: AdstockParams;
}

export interface FitResult {
  curve: MarginalCurve;
  /** Marginal ROAS (revenue $ per spend $) at the reference spend. */
  marginalAt: (spendCents: number) => number;
  /** Calibrated marginal: platform-reported × holdout factor. */
  calibratedMarginalAt: (spendCents: number) => number;
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/** Geometric adstock: carries a decaying fraction of prior spend forward. */
export function applyAdstock(spends: number[], decay: number): number[] {
  const out: number[] = [];
  let carry = 0;
  for (const s of spends) {
    carry = s + decay * carry;
    out.push(carry);
  }
  return out;
}

/** Day-of-week index 0=Sunday..6=Saturday from an ISO timestamp. */
export function dowOf(ts: string): number {
  return new Date(ts).getUTCDay();
}

/**
 * Estimate day-of-week multipliers from the data itself (mean revenue per
 * dow / overall mean), then de-seasonalize. Falls back to flat 1s when a
 * weekday has no observations.
 */
export function estimateSeasonality(points: DataPoint[]): number[] {
  // A weekly pattern cannot be estimated from less than ~2 weeks of data:
  // with exactly 7 points (one per weekday) the estimator would absorb ALL
  // variation and flatten the series to a constant (R²→0). Fall back to flat.
  if (points.length < 14) return new Array(7).fill(1);
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (const p of points) {
    const d = dowOf(p.ts);
    sums[d] += p.revenueCents;
    counts[d] += 1;
  }
  const overall = points.reduce((s, p) => s + p.revenueCents, 0) / Math.max(1, points.length);
  if (overall <= 0) return new Array(7).fill(1);
  return sums.map((s, d) => (counts[d] > 0 ? s / counts[d] / overall : 1));
}

export function deseasonalize(points: DataPoint[], seasonality: number[]): DataPoint[] {
  return points.map((p) => {
    const m = seasonality[dowOf(p.ts)] || 1;
    return { ...p, revenueCents: p.revenueCents / m };
  });
}

// ---------------------------------------------------------------------------
// Least squares
// ---------------------------------------------------------------------------

function linreg(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept, r2: Number.isFinite(r2) ? r2 : 0 };
}

function r2Of(actual: number[], predicted: number[]): number {
  const n = actual.length;
  if (n === 0) return 0;
  const mean = actual.reduce((a, b) => a + b, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (actual[i] - predicted[i]) ** 2;
    ssTot += (actual[i] - mean) ** 2;
  }
  if (ssTot <= 0) return 0;
  return Math.max(0, 1 - ssRes / ssTot);
}

// ---------------------------------------------------------------------------
// Curve forms
// ---------------------------------------------------------------------------

export type CurveFn = {
  predict: (x: number) => number;
  marginal: (x: number) => number; // dy/dx
};

function powerFn(a: number, b: number): CurveFn {
  return {
    predict: (x) => (x <= 0 ? 0 : a * Math.pow(x, b)),
    marginal: (x) => (x <= 0 ? 0 : a * b * Math.pow(x, b - 1)),
  };
}

function loglogFn(a: number, b: number): CurveFn {
  return {
    predict: (x) => (x <= 0 ? 0 : a + b * Math.log(x)),
    marginal: (x) => (x <= 0 ? 0 : b / x),
  };
}

function hillFn(ec50: number, slope: number, vmax: number): CurveFn {
  return {
    predict: (x) => {
      if (x <= 0) return 0;
      const xs = Math.pow(x, slope);
      const e = Math.pow(ec50, slope);
      return (vmax * xs) / (e + xs);
    },
    marginal: (x) => {
      if (x <= 0) return 0;
      const xs = Math.pow(x, slope);
      const e = Math.pow(ec50, slope);
      // d/dx [vmax * x^s / (e + x^s)]
      return (vmax * slope * e * Math.pow(x, slope - 1)) / (e + xs) ** 2;
    },
  };
}

/** Fit y = a·x^b via log-log linear regression (x>0, y>0 rows only). */
function fitPower(xs: number[], ys: number[]): { fn: CurveFn; r2: number; params: CurveParams } {
  const lx: number[] = [];
  const ly: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > 0 && ys[i] > 0) {
      lx.push(Math.log(xs[i]));
      ly.push(Math.log(ys[i]));
    }
  }
  if (lx.length < 3) {
    return { fn: powerFn(0, 0), r2: 0, params: { power: { a: 0, b: 0 } } };
  }
  const { slope: b, intercept } = linreg(lx, ly);
  const a = Math.exp(intercept);
  const fn = powerFn(a, b);
  return { fn, r2: r2Of(ys, xs.map(fn.predict)), params: { power: { a, b } } };
}

/** Fit y = a + b·ln(x) — diminishing without a saturation asymptote. */
function fitLoglog(xs: number[], ys: number[]): { fn: CurveFn; r2: number; params: CurveParams } {
  const lx: number[] = [];
  const yy: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > 0) {
      lx.push(Math.log(xs[i]));
      yy.push(ys[i]);
    }
  }
  if (lx.length < 3) {
    return { fn: loglogFn(0, 0), r2: 0, params: { loglog: { a: 0, b: 0 } } };
  }
  const { slope: b, intercept: a } = linreg(lx, yy);
  const fn = loglogFn(a, b);
  return { fn, r2: r2Of(ys, xs.map(fn.predict)), params: { loglog: { a, b } } };
}

/**
 * Fit Hill y = vmax·x^s/(ec50^s + x^s) by grid search over (ec50, slope),
 * solving vmax by linear least squares at each grid point. Deterministic.
 */
function fitHill(xs: number[], ys: number[]): { fn: CurveFn; r2: number; params: CurveParams } {
  const maxX = Math.max(...xs, 1);
  const ec50Grid = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3].map((m) => m * maxX);
  const slopeGrid = [0.5, 1, 1.5, 2, 3];
  let best = { r2: -1, ec50: maxX, slope: 1, vmax: 0 };
  for (const ec50 of ec50Grid) {
    for (const slope of slopeGrid) {
      const e = Math.pow(ec50, slope);
      const basis = xs.map((x) => {
        const xsp = Math.pow(Math.max(x, 0), slope);
        return xsp / (e + xsp);
      });
      // vmax = argmin Σ(vmax·basis − y)²
      let num = 0;
      let den = 0;
      for (let i = 0; i < xs.length; i++) {
        num += basis[i] * ys[i];
        den += basis[i] * basis[i];
      }
      const vmax = den > 0 ? Math.max(0, num / den) : 0;
      const fn = hillFn(ec50, slope, vmax);
      const r2 = r2Of(ys, xs.map(fn.predict));
      if (r2 > best.r2) best = { r2, ec50, slope, vmax };
    }
  }
  const fn = hillFn(best.ec50, best.slope, best.vmax);
  return {
    fn,
    r2: Math.max(0, best.r2),
    params: { hill: { ec50: best.ec50, slope: best.slope, vmax: best.vmax } },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fit all three forms on adstocked + de-seasonalized data; return the best
 * by R² with marginal-ROAS accessors. Throws on <3 usable points.
 */
export function fitMarginalCurve(input: FitInput): FitResult {
  const { workspaceId, channel, points, dataWindow } = input;
  if (points.length < 3) {
    throw new Error(`Cannot fit ${channel}: need ≥3 points, got ${points.length}.`);
  }
  const sorted = [...points].sort((a, b) => +new Date(a.ts) - +new Date(b.ts));
  const seasonality = estimateSeasonality(sorted);
  const des = deseasonalize(sorted, seasonality);
  const ys = des.map((p) => p.revenueCents);
  const rawSpends = sorted.map((p) => p.spendCents);

  // Adstock decay is fit, not assumed: grid-search the decay and pick the
  // (decay, form) pair with the best R². Forcing carryover on instantaneous
  // data destroys the fit (v1 forced 0.5 and failed R² on clean fixtures).
  // Deterministic: fixed grid, strict improvement required to displace.
  const requestedDecay = input.adstock?.decay;
  const decays = requestedDecay !== undefined ? [requestedDecay] : [...ADSTOCK_DECAY_GRID];
  let best: { decay: number; type: CurveType; fit: { fn: CurveFn; r2: number; params: CurveParams } } | null = null;
  for (const decay of decays) {
    const xs = applyAdstock(rawSpends, decay);
    const candidates: { type: CurveType; fit: { fn: CurveFn; r2: number; params: CurveParams } }[] = [
      { type: "hill", fit: fitHill(xs, ys) },
      { type: "power", fit: fitPower(xs, ys) },
      { type: "loglog", fit: fitLoglog(xs, ys) },
    ];
    candidates.sort((a, b) => b.fit.r2 - a.fit.r2);
    const winner = candidates[0];
    if (!best || winner.fit.r2 > best.fit.r2) {
      best = { decay, type: winner.type, fit: winner.fit };
    }
  }
  const winner = best!;
  const decay = winner.decay;

  const curve: MarginalCurve = {
    id: "",
    workspaceId,
    channel,
    curveType: winner.type,
    params: winner.fit.params,
    adstock: { decay },
    seasonality,
    rSquared: winner.fit.r2,
    dataWindow,
    iroasCalibrationFactor: input.iroasCalibrationFactor,
    fittedAt: new Date().toISOString(),
    modelVersion: MODEL_VERSION,
  };

  const calibration = input.iroasCalibrationFactor ?? 1;
  return {
    curve,
    marginalAt: (spendCents) => winner.fit.fn.marginal(spendCents),
    calibratedMarginalAt: (spendCents) => winner.fit.fn.marginal(spendCents) * calibration,
  };
}

/** Human-readable calibration disagreement, surfaced on the proposal. */
export function calibrationNote(platformMarginal: number, calibratedMarginal: number): string {
  return `platform reports ${platformMarginal.toFixed(2)}x marginal; holdout-calibrated estimate ${calibratedMarginal.toFixed(2)}x`;
}

export { DAY_MS };
