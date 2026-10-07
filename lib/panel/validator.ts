// ShapesOS — Phase 19B (WS=panel): the track record (predicted vs real).
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// Ported from the prototype's src/trust/validator.ts. After a real launch the
// founder enters what actually converted; this compares it with the panel's
// prediction using deterministic statistics (no model, no cost):
//   comparePredictionVsReality — paired per-persona outcomes (the prototype's
//     form), a two-proportion z-test;
//   compareRunWithLaunch — the ShapesOS form: the panel's verdicts against a
//     launch's conversions / visitors (two proportions with their own n);
//   calibrationScore — mean absolute error of predicted vs actual rates over
//     every launch: "predicted within ±X points on N launches".
// "maybe" counts as half a conversion.

export type PanelVerdict = "buy" | "no-buy" | "maybe";

export function verdictToScore(v: PanelVerdict): number {
  switch (v) {
    case "buy":
      return 1;
    case "no-buy":
      return 0;
    case "maybe":
      return 0.5;
  }
}

export type CalibrationVerdict = "within-noise" | "over-predicting" | "under-predicting";

export interface PredictionComparison {
  /** Mean predicted conversion rate (maybe = 0.5). */
  predictedRate: number;
  actualRate: number;
  /** predictedRate - actualRate (positive = the panel over-predicted). */
  delta: number;
  /** Personas in the panel. */
  n: number;
  /** Real visitors (equals n for the paired form). */
  actualN: number;
  test: "two-proportion z-test";
  z: number;
  pValue: number;
  verdict: CalibrationVerdict;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, max abs error ~1.5e-7). */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * erf);
}

/** Pooled two-proportion z-test at alpha 0.05: |z| < 1.96 → within-noise. */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number): { z: number; pValue: number; verdict: CalibrationVerdict; delta: number } {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const delta = p1 - p2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  let z = 0;
  let pValue = 1;
  if (se > 0) {
    z = delta / se;
    pValue = 2 * (1 - normalCdf(Math.abs(z)));
  }
  const verdict: CalibrationVerdict = Math.abs(z) < 1.96 ? "within-noise" : delta > 0 ? "over-predicting" : "under-predicting";
  return { z, pValue, verdict, delta };
}

/** Paired per-persona predictions vs outcomes (equal, non-zero lengths). */
export function comparePredictionVsReality(args: { predicted: PanelVerdict[]; actual: boolean[] }): PredictionComparison {
  const { predicted, actual } = args;
  if (predicted.length === 0 || actual.length === 0) throw new Error("comparePredictionVsReality needs at least one prediction and one outcome");
  if (predicted.length !== actual.length) throw new Error(`predictions (${predicted.length}) and outcomes (${actual.length}) must have equal length`);
  const n = predicted.length;
  const predictedSum = predicted.reduce((s, v) => s + verdictToScore(v), 0);
  const actualSum = actual.reduce((s, b) => s + (b ? 1 : 0), 0);
  const t = twoProportionTest(predictedSum, n, actualSum, n);
  return { predictedRate: predictedSum / n, actualRate: actualSum / n, delta: t.delta, n, actualN: n, test: "two-proportion z-test", z: t.z, pValue: t.pValue, verdict: t.verdict };
}

/** A run's verdicts against a launch's real conversions out of visitors. */
export function compareRunWithLaunch(args: { predicted: PanelVerdict[]; conversions: number; visitors: number }): PredictionComparison {
  const { predicted, conversions, visitors } = args;
  if (predicted.length === 0) throw new Error("No verdicts to compare: a run without verdicts has nothing to calibrate.");
  if (!Number.isInteger(visitors) || visitors <= 0) throw new Error("visitors must be a whole number above 0");
  if (!Number.isInteger(conversions) || conversions < 0 || conversions > visitors) throw new Error("conversions must be a whole number between 0 and visitors");
  const n = predicted.length;
  const predictedSum = predicted.reduce((s, v) => s + verdictToScore(v), 0);
  const t = twoProportionTest(predictedSum, n, conversions, visitors);
  return { predictedRate: predictedSum / n, actualRate: conversions / visitors, delta: t.delta, n, actualN: visitors, test: "two-proportion z-test", z: t.z, pValue: t.pValue, verdict: t.verdict };
}

export interface LaunchCalibration {
  predictedRate: number;
  actualRate: number;
}

/** Mean absolute error across launches (lower is better). */
export function calibrationScore(history: LaunchCalibration[]): number {
  if (history.length === 0) throw new Error("calibrationScore needs at least one launch");
  return history.reduce((s, h) => s + Math.abs(h.predictedRate - h.actualRate), 0) / history.length;
}
