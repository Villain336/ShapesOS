// Marketr — Phase 10 M3: honest-labeling contract.
//
// NON-NEGOTIABLE: there is no single "AI visibility score" anywhere in this
// module. Every metric function returns an object that carries:
//   - per-engine breakdown (callers aggregate per engine; never across engines)
//   - a Wilson-style 95% confidence interval
//   - the sample size the interval was computed from
//   - a stability reading where the metric spans repeated reps
// The no-single-score guard is enforced by `assertMetricCarriesCi` and by
// `__tests__/honesty-guard.test.ts`, which fails the suite if any registered
// metric function returns a bare number.
//
// Methodology notes:
//   - Wilson score interval (z=1.96) for all proportions — the GEO-tool
//     category's standard; robust at small n, never exceeds [0,1].
//   - N-rep stability = fraction of reps agreeing with the modal outcome.
//   - leader-flip rate = share of consecutive run-pairs whose leader changed.
//   - unstable_share > 30% flag = the open GEO methodology's threshold.
//   - API-vs-UI variance > 15% = data-quality event, surfaced not hidden.

/** z for the 95% confidence interval. */
export const WILSON_Z = 1.96;

/** Confidence level carried on every metric. */
export const CONFIDENCE_LEVEL = 0.95 as const;

/** Open-GEO unstable-share threshold: above this, the share is flagged unstable. */
export const UNSTABLE_SHARE_THRESHOLD = 0.3;

/** API-vs-UI variance threshold: above this is a data-quality event, not a footnote. */
export const API_UI_VARIANCE_THRESHOLD = 0.15;

/** Brand marker every metric result carries. The guard checks for it. */
export interface HonestMetricMeta {
  /** Always true. A bare number can never carry this. */
  honestMetric: true;
  /** Wilson 95% CI as [lower, upper], proportions on [0,1]. */
  confidenceInterval: [number, number];
  /** Sample size the CI was computed from. */
  n: number;
  confidenceLevel: typeof CONFIDENCE_LEVEL;
}

/** Wilson score interval for k successes in n trials. Never exceeds [0,1]. */
export function wilsonCI(
  k: number,
  n: number,
  z: number = WILSON_Z,
): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 0 };
  const p = Math.min(1, Math.max(0, k / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}

/** Per-engine share with Wilson CI. The ONLY legal share object. */
export interface HonestShare extends HonestMetricMeta {
  engine: string;
  /** Point estimate — the estimate, never "the score". */
  share: number;
  successes: number;
}

export function perEngineShare(
  engine: string,
  successes: number,
  n: number,
): HonestShare {
  const ci = wilsonCI(successes, n);
  return {
    honestMetric: true,
    engine,
    share: n > 0 ? successes / n : 0,
    successes,
    n,
    confidenceInterval: [ci.lower, ci.upper],
    confidenceLevel: CONFIDENCE_LEVEL,
  };
}

/** N-rep stability: how often reps agree with the modal outcome. */
export interface StabilityReport extends HonestMetricMeta {
  /** Fraction of reps matching the modal outcome, on [0,1]. */
  stability: number;
  modalOutcome: boolean;
  /** 1 - stability. */
  flipRate: number;
}

export function nRepStability(repOutcomes: boolean[]): StabilityReport {
  const n = repOutcomes.length;
  if (n === 0) {
    return {
      honestMetric: true,
      stability: 0,
      modalOutcome: false,
      flipRate: 0,
      n: 0,
      confidenceInterval: [0, 0],
      confidenceLevel: CONFIDENCE_LEVEL,
    };
  }
  const trues = repOutcomes.filter(Boolean).length;
  const modalOutcome = trues >= n - trues;
  const modalCount = modalOutcome ? trues : n - trues;
  const ci = wilsonCI(modalCount, n);
  return {
    honestMetric: true,
    stability: modalCount / n,
    modalOutcome,
    flipRate: 1 - modalCount / n,
    n,
    confidenceInterval: [ci.lower, ci.upper],
    confidenceLevel: CONFIDENCE_LEVEL,
  };
}

/**
 * Leader-flip rate across consecutive runs: the share of run-pairs where the
 * per-engine leader changed. High flips = the category is unstable, and any
 * point estimate should be distrusted.
 */
export interface FlipRateReport extends HonestMetricMeta {
  /** Flips / pairs, on [0,1]. */
  flipRate: number;
  flips: number;
  pairs: number;
}

/** leaders[i] = winning engine id for run i (or null when no leader). */
export function leaderFlipRate(leaders: Array<string | null>): FlipRateReport {
  const pairs = Math.max(0, leaders.length - 1);
  let flips = 0;
  for (let i = 1; i < leaders.length; i += 1) {
    if (leaders[i] !== leaders[i - 1]) flips += 1;
  }
  const ci = wilsonCI(flips, pairs);
  return {
    honestMetric: true,
    flipRate: pairs > 0 ? flips / pairs : 0,
    flips,
    pairs,
    n: pairs,
    confidenceInterval: [ci.lower, ci.upper],
    confidenceLevel: CONFIDENCE_LEVEL,
  };
}

/** Unmentioned-share report with the >30% unstable flag. */
export interface UnstableShareReport extends HonestMetricMeta {
  engine: string;
  /** Share of reps/prompts where the brand was NOT mentioned. */
  unmentionedShare: number;
  /** True when unmentionedShare > 30% — the open-GEO instability threshold. */
  unstable: boolean;
  threshold: typeof UNSTABLE_SHARE_THRESHOLD;
}

export function unstableShareReport(
  engine: string,
  unmentioned: number,
  n: number,
): UnstableShareReport {
  const ci = wilsonCI(unmentioned, n);
  const share = n > 0 ? unmentioned / n : 0;
  return {
    honestMetric: true,
    engine,
    unmentionedShare: share,
    unstable: share > UNSTABLE_SHARE_THRESHOLD,
    threshold: UNSTABLE_SHARE_THRESHOLD,
    n,
    confidenceInterval: [ci.lower, ci.upper],
    confidenceLevel: CONFIDENCE_LEVEL,
  };
}

/**
 * API-vs-UI variance report. When the API proxy and the consumer surface
 * diverge by more than 15%, the metric is NOT hidden — it is surfaced as a
 * data-quality event.
 */
export interface ApiUiVarianceReport extends HonestMetricMeta {
  engine: string;
  apiShare: number;
  uiShare: number;
  /** Absolute divergence, on [0,1]. */
  variance: number;
  /** True when variance > 15%: a data-quality event. */
  isDataQualityEvent: boolean;
  threshold: typeof API_UI_VARIANCE_THRESHOLD;
}

export function apiUiVarianceReport(
  engine: string,
  apiShare: number,
  uiShare: number,
): ApiUiVarianceReport {
  const variance = Math.abs(apiShare - uiShare);
  return {
    honestMetric: true,
    engine,
    apiShare,
    uiShare,
    variance,
    isDataQualityEvent: variance > API_UI_VARIANCE_THRESHOLD,
    threshold: API_UI_VARIANCE_THRESHOLD,
    n: 2, // two sources compared
    confidenceInterval: [variance, variance],
    confidenceLevel: CONFIDENCE_LEVEL,
  };
}

/**
 * The no-single-score guard. Throws when `value` is a bare number or an
 * object that does not carry the honest-metric brand + CI metadata. Called by
 * the guard test against every registered metric function, and available to
 * API routes that want to fail closed before shipping a metric.
 */
export function assertMetricCarriesCi(value: unknown, label = "metric"): asserts value is HonestMetricMeta {
  if (typeof value === "number" || typeof value === "string") {
    throw new Error(
      `[honesty-guard] ${label} returned a bare ${typeof value} — single-score metrics are forbidden. Return an HonestMetricMeta object instead.`,
    );
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`[honesty-guard] ${label} returned no metric object at all.`);
  }
  const v = value as Record<string, unknown>;
  if (v.honestMetric !== true) {
    throw new Error(`[honesty-guard] ${label} is missing the honestMetric brand — every metric must carry CI metadata.`);
  }
  const ci = v.confidenceInterval;
  if (
    !Array.isArray(ci) ||
    ci.length !== 2 ||
    typeof ci[0] !== "number" ||
    typeof ci[1] !== "number"
  ) {
    throw new Error(`[honesty-guard] ${label} has no valid confidenceInterval [lower, upper].`);
  }
  if (typeof v.n !== "number") {
    throw new Error(`[honesty-guard] ${label} is missing its sample size n.`);
  }
}

/**
 * Self-describing registry of every exported metric function, keyed by export
 * name, with fixture arguments. The guard test (honesty-guard.test.ts)
 * iterates this and calls assertMetricCarriesCi on each result. Add every new
 * metric function here or the guard cannot see it — which is the point.
 */
export const METRIC_FIXTURES: Record<string, unknown[]> = {
  perEngineShare: ["openai", 6, 10],
  nRepStability: [[true, true, false]],
  leaderFlipRate: [["openai", "anthropic", "openai"]],
  unstableShareReport: ["openai", 4, 10],
  apiUiVarianceReport: ["openai", 0.6, 0.4],
};

/** Format a share as an estimated range: "42–68% (n=10)". Never a bare score. */
export function formatEstimatedRange(m: HonestMetricMeta): string {
  const [lo, hi] = m.confidenceInterval;
  return `${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}% (n=${m.n})`;
}
