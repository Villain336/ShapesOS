// Marketr — Phase 7 F1: built-in geo-holdout planner.
//
// Incrementality calibration for the marginal-ROAS curves: the planner
// designs a geo-holdout experiment (matched market pairs, treatment vs
// control, duration + minimum-detectable-lift math). The measured lift
// becomes the per-channel iROAS calibration factor ("platform reports 4.2×;
// holdout-calibrated 2.6×").
//
// Deterministic: matched-pair assignment by baseline, no randomness.

export interface GeoMarket {
  id: string;
  label: string;
  baselineSpendCents: number;
  baselineRevenueCents: number;
}

export interface GeoHoldoutInput {
  workspaceId: string;
  channel: string;
  markets: GeoMarket[];
  /** Fractional lift to detect, e.g. 0.15 = 15%. */
  liftToDetect: number;
  power?: number; // default 0.8
  alpha?: number; // default 0.05
  /** Weekly revenue volatility (coefficient of variation). Default 0.3. */
  cv?: number;
}

export interface GeoHoldoutPlan {
  channel: string;
  pairs: { treatment: GeoMarket; control: GeoMarket }[];
  unmatched: GeoMarket[];
  weeks: number;
  minDetectableLift: number;
  readOut: string;
  /** How the measured lift feeds the curve: iroas = 1 + measuredLift. */
  calibrationGuidance: string;
}

/**
 * Duration math (paired design): n_weeks ≈ 2·((zα + zβ)·cv / lift)²,
 * rounded up, minimum 2 weeks (one full business cycle is the floor).
 */
export function estimateHoldoutWeeks(lift: number, cv: number, alpha = 0.05, power = 0.8): number {
  const zAlpha = alpha <= 0.01 ? 2.576 : 1.96;
  const zBeta = power >= 0.9 ? 1.282 : 0.842;
  const weeks = 2 * Math.pow(((zAlpha + zBeta) * cv) / Math.max(lift, 1e-6), 2);
  return Math.max(2, Math.ceil(weeks));
}

export function planGeoHoldout(input: GeoHoldoutInput): GeoHoldoutPlan {
  const { markets, liftToDetect } = input;
  if (markets.length < 4) {
    throw new Error(`Geo-holdout needs ≥4 markets for matched pairs, got ${markets.length}.`);
  }
  if (liftToDetect <= 0 || liftToDetect >= 1) {
    throw new Error("liftToDetect must be within (0, 1).");
  }
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  const cv = input.cv ?? 0.3;

  // Matched pairs: sort by baseline revenue, pair neighbors, then split each
  // pair deterministically (lower id → treatment) so the plan is replayable.
  const sorted = [...markets].sort((a, b) => a.baselineRevenueCents - b.baselineRevenueCents);
  const pairs: { treatment: GeoMarket; control: GeoMarket }[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const [m1, m2] = [sorted[i], sorted[i + 1]];
    const treatment = m1.id < m2.id ? m1 : m2;
    const control = treatment === m1 ? m2 : m1;
    pairs.push({ treatment, control });
  }
  const unmatched = sorted.length % 2 === 1 ? [sorted[sorted.length - 1]] : [];
  const weeks = estimateHoldoutWeeks(liftToDetect, cv, alpha, power);

  const treatedSpend = pairs.reduce((s, p) => s + p.treatment.baselineSpendCents, 0);
  return {
    channel: input.channel,
    pairs,
    unmatched,
    weeks,
    minDetectableLift: liftToDetect,
    readOut:
      `Hold ${pairs.length} control markets dark on ${input.channel} for ${weeks} weeks while ` +
      `treatment markets spend ~$${(treatedSpend / 100).toFixed(0)}/wk. ` +
      `Incremental lift = (treatment − control) / control, matched-pair t-test at α=${alpha}.`,
    calibrationGuidance:
      `Set the channel's iroasCalibrationFactor = 1 + measuredLift (e.g. measured +12% → 1.12). ` +
      `The optimizer multiplies platform-reported marginal ROAS by this factor and surfaces the disagreement on every proposal.`,
  };
}
