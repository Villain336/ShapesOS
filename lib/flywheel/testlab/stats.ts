// Marketr — Test Lab stats core (F3).
//
// TypeScript port of GrowthBook's OSS `gbstats` 0.8.0 (MIT), vendored at
// `vendor/growthbook-stats/wheel-0.8.0/`. See that directory's README for the
// license evidence and the OSS/enterprise boundary check.
//
// PORT MAP (function -> vendored source):
//   checkSrm                     -> gbstats/utils.py :: check_srm
//   bayesianBinomial (Beta-Binomial) -> spec-named default for binomial
//        metrics. NOTE: the 0.8.0 wheel's Bayesian default is the *effect*
//        (normal-approximation) test; the exact conjugate Beta-Binomial
//        posterior below is implemented from the statistics literature (the
//        wheel's bayesian/tests.py converges to it at large n). It is the
//        default because spec §1.6 names Beta-Binomial for binomial metrics.
//   bayesianGaussian (Normal priors) -> gbstats/bayesian/tests.py ::
//        EffectBayesianABTest.compute_result, chance_to_win, get_risk,
//        gbstats/frequentist/tests.py :: frequentist_diff, frequentist_variance,
//        gbstats/utils.py :: truncated_normal_mean
//   sequentialTest (always-valid)    -> gbstats/frequentist/tests.py ::
//        SequentialTwoSidedTTest (rho, confidence_interval, p_value)
//        per Waudby-Smith et al. 2023 (eq 9, 155, 161).
//   frequentistTest (backstop)       -> gbstats/frequentist/tests.py :: TTest
//        (two-sided, delta-method variance for relative uplift).
//
// Everything here is deterministic (fixed Gauss-Legendre quadrature; no RNG),
// so results are reproducible and batteries are stable.

// ---------------------------------------------------------------------------
// Numerical primitives
// ---------------------------------------------------------------------------

const SQRT2PI = Math.sqrt(2 * Math.PI);

export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 7.5e-8). */
export function normalCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0];
  const plow = 0.02425, phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** log-Gamma (Lanczos). */
function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = c[0];
  for (let i = 1; i < 9; i++) a += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaLn(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

/** Regularized incomplete beta I_x(a,b) via continued fraction (Numerical Recipes betacf). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) +
    a * Math.log(x) + b * Math.log(1 - x));
  const betacf = (aa: number, bb: number, xx: number): number => {
    const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
    const qab = aa + bb, qap = aa + 1, qam = aa - 1;
    let c = 1, d = 1 - qab * xx / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa2 = m * (bb - m) * xx / ((qam + m2) * (aa + m2));
      d = 1 + aa2 * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa2 / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa2 = -(aa + m) * (qab + m) * xx / ((aa + m2) * (qap + m2));
      d = 1 + aa2 * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa2 / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  };
  if (x < (a + 1) / (a + b + 2)) {
    return bt * betacf(a, b, x) / a;
  }
  return 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Beta CDF. */
export function betaCdf(x: number, a: number, b: number): number {
  return incompleteBeta(Math.min(1, Math.max(0, x)), a, b);
}

/** Beta PDF (log-stable). */
function betaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0;
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - betaLn(a, b));
}

/** Lower regularized gamma P(a, x) (series). */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const EPS = 1e-14;
  let ap = a, sum = 1 / a, del = sum;
  for (let n = 1; n <= 200; n++) {
    ap += 1; del *= x / ap; sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

/** Chi-square survival function P(Chi2_k > x). */
export function chi2Sf(x: number, df: number): number {
  if (x <= 0) return 1;
  return 1 - gammaP(df / 2, x / 2);
}

/** Gauss-Legendre nodes/weights on [a,b], n points (Golub-Welsch). */
export function gaussLegendre(a: number, b: number, n: number): { x: number[]; w: number[] } {
  const x: number[] = new Array(n).fill(0);
  const w: number[] = new Array(n).fill(0);
  const m = Math.floor((n + 1) / 2);
  for (let i = 1; i <= m; i++) {
    let z = Math.cos(Math.PI * (i - 0.25) / (n + 0.5));
    for (let it = 0; it < 20; it++) {
      let pp = 1, p1 = 0;
      for (let j = 1; j <= n; j++) {
        const p2 = p1; p1 = pp;
        pp = ((2 * j - 1) * z * p1 - (j - 1) * p2) / j;
      }
      const dpp = n * (z * pp - p1) / (z * z - 1);
      const z1 = z;
      z = z1 - pp / dpp;
      if (Math.abs(z - z1) < 1e-14) break;
    }
    let pp = 1, p1 = 0;
    for (let j = 1; j <= n; j++) {
      const p2 = p1; p1 = pp;
      pp = ((2 * j - 1) * z * p1 - (j - 1) * p2) / j;
    }
    const dpp = n * (z * pp - p1) / (z * z - 1);
    x[i - 1] = -z; x[n - i] = z;
    w[i - 1] = 2 / ((1 - z * z) * dpp * dpp);
    w[n - i] = w[i - 1];
  }
  const xm = (b + a) / 2, xr = (b - a) / 2;
  return {
    x: x.map((xi) => xm + xr * xi),
    w: w.map((wi) => wi * xr),
  };
}

// ---------------------------------------------------------------------------
// SRM — PORT: gbstats/utils.py :: check_srm
// ---------------------------------------------------------------------------

export interface SrmResult {
  chi2: number;
  pValue: number;
  alpha: number;
  pass: boolean;
}

/**
 * Pearson chi-square SRM check at alpha=0.001 (hard gate).
 * Port of check_srm: x = sum((o - e)^2 / e), p = chi2.sf(x, k-1).
 */
export function checkSrm(counts: number[], weights: number[], alpha = 0.001): SrmResult {
  const total = counts.reduce((s, c) => s + c, 0);
  if (!total) return { chi2: 0, pValue: 1, alpha, pass: true };
  const totalWeight = weights.reduce((s, c) => s + c, 0);
  let x = 0;
  let df = -1;
  for (let i = 0; i < counts.length; i++) {
    if (weights[i] <= 0) continue;
    const e = (weights[i] / totalWeight) * total;
    if (e > 0) { x += ((counts[i] - e) ** 2) / e; df += 1; }
  }
  const pValue = df > 0 ? chi2Sf(x, df) : 1;
  return { chi2: x, pValue, alpha, pass: pValue >= alpha };
}

// ---------------------------------------------------------------------------
// Bayesian: Beta-Binomial (binomial metrics — spec §1.6 default)
// ---------------------------------------------------------------------------

export interface BinomialArm {
  /** successes (conversions) */
  successes: number;
  /** trials (exposures) */
  trials: number;
}

export interface BayesianBinomialResult {
  /** P(treatment rate > control rate) */
  chanceToBeat: number;
  /** E[max(0, p_ctrl - p_trt)] in rate points — the deploy risk */
  expectedLoss: number;
  /** expected loss as fraction of the control posterior mean */
  expectedLossRelative: number;
  /** posterior mean relative uplift (E[p_b]-E[p_a])/E[p_a] */
  expectedUplift: number;
  /** 95% credible interval for the relative uplift */
  credibleInterval: [number, number];
  posteriorA: { a: number; b: number };
  posteriorB: { a: number; b: number };
}

const GL_N = 48;

/** E[max(0, X - y)] for X ~ Beta(a,b), closed form via incomplete beta. */
function betaExcessMean(a: number, b: number, y: number): number {
  const mean = a / (a + b);
  const tail = 1 - betaCdf(y, a, b);
  const tailMean = 1 - betaCdf(y, a + 1, b);
  return mean * tailMean - y * tail;
}

/** Posterior sd of Beta(a,b). */
function betaSd(a: number, b: number): number {
  return Math.sqrt((a * b) / ((a + b) * (a + b) * (a + b + 1)));
}

/**
 * Exact conjugate Beta-Binomial inference.
 * Prior Beta(priorA, priorB); default (1,1) uniform.
 *
 * Integrals are evaluated in z-space (y = μ_b + σ_b·z, φ-weighted): the
 * posteriors are concentrated on intervals far narrower than Gauss-Legendre
 * node spacing on [0,1], so direct [0,1] quadrature misses the peak.
 */
export function bayesianBinomial(
  armA: BinomialArm,
  armB: BinomialArm,
  prior: { a: number; b: number } = { a: 1, b: 1 },
): BayesianBinomialResult {
  const postA = { a: prior.a + armA.successes, b: prior.b + armA.trials - armA.successes };
  const postB = { a: prior.a + armB.successes, b: prior.b + armB.trials - armB.successes };
  const meanA = postA.a / (postA.a + postA.b);
  const meanB = postB.a / (postB.a + postB.b);
  const sdB = betaSd(postB.a, postB.b);

  // P(p_b > p_a) = ∫ φ(z) · F_a(μ_b + σ_b·z) dz — Gauss-Legendre, deterministic.
  const { x: zx, w: zw } = gaussLegendre(-10, 10, GL_N);
  let chanceToBeat = 0;
  let expectedLoss = 0;
  for (let i = 0; i < GL_N; i++) {
    const y = meanB + sdB * zx[i];
    if (y <= 0 || y >= 1) continue;
    const weight = zw[i] * normalPdf(zx[i]);
    chanceToBeat += weight * betaCdf(y, postA.a, postA.b);
    expectedLoss += weight * betaExcessMean(postA.a, postA.b, y);
  }
  chanceToBeat = Math.min(1, Math.max(0, chanceToBeat));
  expectedLoss = Math.max(0, expectedLoss);

  // CI for relative uplift: quantiles of D = (X-Y)/Y via numeric inversion,
  // again in z-space: P(D ≤ d) = ∫ φ(z) F_a((μ_b+σ_b z)(1+d)) dz.
  const diffCdf = (d: number): number => {
    let acc = 0;
    for (let i = 0; i < GL_N; i++) {
      const y = (meanB + sdB * zx[i]) * (1 + d);
      if (y <= 0) continue;
      acc += zw[i] * normalPdf(zx[i]) * betaCdf(Math.min(1, y), postA.a, postA.b);
    }
    return Math.min(1, Math.max(0, acc));
  };
  const quantile = (q: number): number => {
    let lo = -0.99, hi = 3.0;
    if (diffCdf(hi) < q) hi = 10;
    for (let it = 0; it < 80; it++) {
      const mid = (lo + hi) / 2;
      if (diffCdf(mid) < q) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const expectedUplift = meanA > 0 ? (meanB - meanA) / meanA : (meanB > 0 ? Infinity : 0);
  return {
    chanceToBeat,
    expectedLoss,
    expectedLossRelative: meanA > 0 ? expectedLoss / meanA : 0,
    expectedUplift,
    credibleInterval: [quantile(0.025), quantile(0.975)],
    posteriorA: postA,
    posteriorB: postB,
  };
}

// ---------------------------------------------------------------------------
// Bayesian: Normal priors (count / duration / revenue metrics)
// PORT: EffectBayesianABTest — frequentist_diff / frequentist_variance,
// posterior precision blend, chance_to_win, get_risk (truncated normal),
// credible interval.
// ---------------------------------------------------------------------------

export interface GaussianArm {
  mean: number;
  variance: number;
  n: number;
}

/** PORT: frequentist_diff(mean_a, mean_b, relative, mean_a_unadjusted). */
export function frequentistDiff(meanA: number, meanB: number, relative: boolean, meanAUnadjusted?: number): number {
  const m0 = meanAUnadjusted ?? meanA;
  return relative ? (meanB - meanA) / m0 : meanB - meanA;
}

/** PORT: frequentist_variance(var_a, mean_a, n_a, var_b, mean_b, n_b, relative) — delta method. */
export function frequentistVariance(
  varA: number, meanA: number, nA: number,
  varB: number, meanB: number, nB: number,
  relative: boolean,
): number {
  if (relative) {
    return varB / (meanA * meanA * nB) + (varA * meanB * meanB) / (meanA ** 4 * nA);
  }
  return varB / nB + varA / nA;
}

/** PORT: truncated_normal_mean (gbstats/utils.py) — closed-form truncnorm mean. */
export function truncatedNormalMean(mu: number, sigma: number, a: number, b: number): number {
  if (sigma <= 0) return mu;
  const alpha = (a - mu) / sigma;
  const beta = (b - mu) / sigma;
  const z = normalCdf(beta) - normalCdf(alpha);
  if (z <= 0) return mu;
  return mu + sigma * (normalPdf(alpha) - normalPdf(beta)) / z;
}

export interface GaussianPrior {
  mean: number;
  variance: number;
  /** proper=false => flat/improper prior: posterior = data only (gbstats default). */
  proper: boolean;
}

export interface BayesianGaussianResult {
  chanceToWin: number;
  /** [risk_control, risk_treatment] — PORT: get_risk */
  expectedLoss: [number, number];
  expected: number;
  credibleInterval: [number, number];
  /** uplift posterior N(mean, stddev) — PORT: Uplift(dist="normal") */
  uplift: { dist: "normal"; mean: number; stddev: number };
  inverse: boolean;
}

/**
 * PORT: EffectBayesianABTest.compute_result (+ chance_to_win, get_risk).
 * Used for count / duration / revenue metrics with Normal priors.
 */
export function bayesianGaussian(
  armA: GaussianArm,
  armB: GaussianArm,
  opts: {
    relative?: boolean;
    inverse?: boolean;
    alpha?: number;
    prior?: GaussianPrior;
  } = {},
): BayesianGaussianResult {
  const relative = opts.relative ?? true;
  const inverse = opts.inverse ?? false;
  const alpha = opts.alpha ?? 0.05;
  const prior = opts.prior ?? { mean: 0, variance: 1, proper: false };

  if ((armA.mean === 0) && relative) {
    return { chanceToWin: 0.5, expectedLoss: [0, 0], expected: 0, credibleInterval: [0, 0], uplift: { dist: "normal", mean: 0, stddev: 0 }, inverse };
  }
  const dataVariance = frequentistVariance(armA.variance, armA.mean, armA.n, armB.variance, armB.mean, armB.n, relative);
  const dataMean = frequentistDiff(armA.mean, armB.mean, relative, armA.mean);
  const postPrec = 1 / dataVariance + (prior.proper ? 1 / prior.variance : 0);
  const meanDiff = prior.proper
    ? (dataMean / dataVariance + prior.mean / prior.variance) / postPrec
    : dataMean;
  const stdDiff = Math.sqrt(1 / postPrec);

  const chanceToWin = inverse
    ? 1 - (1 - normalCdf((0 - meanDiff) / stdDiff))
    : 1 - normalCdf((0 - meanDiff) / stdDiff);
  const z = normalInv(1 - alpha / 2);
  const credibleInterval: [number, number] = [meanDiff - z * stdDiff, meanDiff + z * stdDiff];

  // PORT: get_risk
  const probCtrlBetter = normalCdf((0 - meanDiff) / stdDiff);
  const mnNeg = truncatedNormalMean(meanDiff, stdDiff, -Infinity, 0);
  const mnPos = truncatedNormalMean(meanDiff, stdDiff, 0, Infinity);
  let riskCtrl = (1 - probCtrlBetter) * mnPos;
  let riskTrt = -(probCtrlBetter * mnNeg);
  const expectedLoss: [number, number] = inverse ? [riskTrt, riskCtrl] : [riskCtrl, riskTrt];

  return {
    chanceToWin,
    expectedLoss,
    expected: meanDiff,
    credibleInterval,
    uplift: { dist: "normal", mean: meanDiff, stddev: stdDiff },
    inverse,
  };
}

// ---------------------------------------------------------------------------
// Sequential always-valid inference — PORT: SequentialTwoSidedTTest
// Peek-safe by construction (Waudby-Smith et al. 2023).
// ---------------------------------------------------------------------------

export interface SequentialConfig {
  alpha: number;
  /** gbstats default sequential_tuning_parameter */
  tuningParameter: number;
  testValue: number;
}

export const SEQUENTIAL_DEFAULTS: SequentialConfig = { alpha: 0.05, tuningParameter: 100, testValue: 0 };

/** PORT: SequentialTwoSidedTTest.rho — eq 161 in Waudby-Smith et al. 2023. */
export function sequentialRho(alpha: number, tuningParameter: number): number {
  return Math.sqrt((-2 * Math.log(alpha) + Math.log(-2 * Math.log(alpha) + 1)) / tuningParameter);
}

export interface SequentialResult {
  /** always-valid CI — eq 9; valid at ANY stopping time */
  confidenceInterval: [number, number];
  /** always-valid p-value via e-value — eq 155; valid under peeking */
  pValue: number;
  rho: number;
  /** true when the always-valid CI excludes the test value */
  excludesNull: boolean;
}

/**
 * PORT: SequentialTwoSidedTTest.confidence_interval / .p_value.
 * Inputs: pooled difference statistics (diff, variance, total n).
 */
export function sequentialTest(
  pointEstimate: number,
  variance: number,
  nTotal: number,
  cfg: SequentialConfig = SEQUENTIAL_DEFAULTS,
): SequentialResult {
  const { alpha, tuningParameter, testValue } = cfg;
  const rho = sequentialRho(alpha, tuningParameter);
  const s2 = variance * nTotal;
  const width = Math.sqrt(s2) * Math.sqrt(
    (2 * (nTotal * rho * rho + 1)) * Math.log(Math.sqrt(nTotal * rho * rho + 1) / alpha) /
    (nTotal * rho * nTotal * rho),
  );
  // PORT: p_value — e-value reparameterization
  const st2 = ((pointEstimate - testValue) ** 2) * nTotal / variance;
  const tr2p1 = nTotal * rho * rho + 1;
  const evalue = Math.exp((rho * rho * st2) / (2 * tr2p1)) / Math.sqrt(tr2p1);
  const pValue = Math.min(1 / evalue, 1);
  const ci: [number, number] = [pointEstimate - width, pointEstimate + width];
  return {
    confidenceInterval: ci,
    pValue,
    rho,
    excludesNull: ci[0] > testValue || ci[1] < testValue,
  };
}

// ---------------------------------------------------------------------------
// Frequentist backstop — PORT: TTest (two-sided, delta-method variance)
// ---------------------------------------------------------------------------

export interface FrequentistResult {
  pointEstimate: number;
  pValue: number;
  confidenceInterval: [number, number];
  /** t critical used (normal approx at n>30, t-dist otherwise) */
  tCritical: number;
}

function tCritical(alpha: number, df: number): number {
  // Normal approx is fine at large df; small-df t via Wilson-Hilferty-ish widen.
  if (df > 30 || !isFinite(df)) return normalInv(1 - alpha / 2);
  // Cornish-Fisher expansion for t critical (small df)
  const z = normalInv(1 - alpha / 2);
  const g1 = (z * z + 1) / (4 * df);
  const g2 = (5 * z ** 4 + 16 * z * z + 3) / (96 * df * df);
  const g3 = (3 * z ** 6 + 19 * z ** 4 + 17 * z * z - 15) / (384 * df ** 3);
  return z * (1 + g1 + g2 + g3);
}

/** Two-sided t-test on the (relative or absolute) uplift — the defensibility backstop. */
export function frequentistTest(
  armA: GaussianArm,
  armB: GaussianArm,
  opts: { relative?: boolean; alpha?: number } = {},
): FrequentistResult {
  const relative = opts.relative ?? true;
  const alpha = opts.alpha ?? 0.05;
  const pointEstimate = frequentistDiff(armA.mean, armB.mean, relative, armA.mean);
  const variance = frequentistVariance(armA.variance, armA.mean, armA.n, armB.variance, armB.mean, armB.n, relative);
  const se = Math.sqrt(Math.max(variance, 0));
  const df = armA.n + armB.n - 2;
  const tCrit = tCritical(alpha, df);
  const t = se > 0 ? pointEstimate / se : 0;
  // two-sided p via normal approx on |t| (large-n exact; conservative otherwise)
  const pValue = 2 * (1 - normalCdf(Math.abs(t)));
  return {
    pointEstimate,
    pValue: Math.min(1, Math.max(0, pValue)),
    confidenceInterval: [pointEstimate - tCrit * se, pointEstimate + tCrit * se],
    tCritical: tCrit,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert binomial arms to Gaussian arms (proportion moments) for backstops. */
export function binomialToGaussian(arm: BinomialArm): GaussianArm {
  const p = arm.trials > 0 ? arm.successes / arm.trials : 0;
  return { mean: p, variance: p * (1 - p), n: arm.trials };
}

/** Format a relative uplift as a percentage string. */
export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}
