// Marketr — Test Lab integrity battery (F3).
//
// Runs BEFORE the honesty dashboard renders a verdict, in this order:
//   SRM → coverage → pre-period parity → exposure leakage →
//   concurrent-test contamination → metric volatility.
//
// SRM failure is a HARD render gate: results refuse to render
// ("EXPERIMENT COMPROMISED"), per spec §9 invariant 10.

import { checkSrm } from "./stats";

export type IntegritySeverity = "hard_fail" | "warn" | "pass";

export interface IntegrityCheck {
  name: string;
  severity: IntegritySeverity;
  detail: string;
  metric?: Record<string, number>;
}

export interface IntegrityBatteryInput {
  /** randomized units per variant (SRM) */
  armCounts: number[];
  /** expected traffic weights per variant */
  armWeights: number[];
  /** every randomized unit accounted for in the metric query? */
  coverage: { randomizedUnits: number; unitsInAnalysis: number };
  /** pre-period parity: per-variant pre-period metric means */
  prePeriodMeans: number[];
  prePeriodNs: number[];
  /** exposure leakage: fraction of control units exposed to treatment content */
  exposureLeakageRate: number;
  /** concurrent tests touching the same audience/page */
  concurrentTests: { testId: string; overlap: number; directionRisk: "low" | "high" }[];
  /** metric volatility: daily conversion-rate stdev vs historical */
  volatility: { observedDailySd: number; historicalDailySd: number };
}

export interface IntegrityBatteryResult {
  checks: IntegrityCheck[];
  /** false ONLY on hard_fail (SRM) — results refuse to render */
  renderAllowed: boolean;
  compromised: boolean;
}

const SRM_ALPHA = 0.001;

export function runIntegrityBattery(input: IntegrityBatteryInput): IntegrityBatteryResult {
  const checks: IntegrityCheck[] = [];

  // 1. SRM — HARD GATE
  const srm = checkSrm(input.armCounts, input.armWeights, SRM_ALPHA);
  checks.push({
    name: "srm",
    severity: srm.pass ? "pass" : "hard_fail",
    detail: srm.pass
      ? `SRM χ² p=${srm.pValue.toExponential(2)} ≥ ${SRM_ALPHA} — randomization intact.`
      : `SRM χ² p=${srm.pValue.toExponential(2)} < ${SRM_ALPHA} — randomization BROKEN. Results will not render.`,
    metric: { chi2: srm.chi2, pValue: srm.pValue },
  });

  // 2. Coverage — all randomized units present in the metric query
  const covRate = input.coverage.randomizedUnits > 0
    ? input.coverage.unitsInAnalysis / input.coverage.randomizedUnits
    : 1;
  checks.push({
    name: "coverage",
    severity: covRate >= 0.99 ? "pass" : covRate >= 0.95 ? "warn" : "hard_fail",
    detail: covRate >= 0.99
      ? `${(covRate * 100).toFixed(1)}% of randomized units present in analysis.`
      : `Only ${(covRate * 100).toFixed(1)}% of randomized units reach the analysis — missing units can bias the result.`,
    metric: { coverageRate: covRate },
  });

  // 3. Pre-period parity — variants should look identical before the test
  let paritySev: IntegritySeverity = "pass";
  let parityDetail = "Pre-period metric means agree across variants.";
  let maxSpread = 0;
  if (input.prePeriodMeans.length >= 2 && input.prePeriodNs.every((n) => n > 0)) {
    const means = input.prePeriodMeans;
    const max = Math.max(...means), min = Math.min(...means);
    const base = Math.abs(max) > 0 ? Math.abs(max) : 1;
    maxSpread = Math.abs(max - min) / base;
    if (maxSpread > 0.1) { paritySev = "warn"; parityDetail = `Pre-period means differ by ${(maxSpread * 100).toFixed(1)}% — check randomization or metric definition.`; }
    if (maxSpread > 0.25) { paritySev = "hard_fail"; parityDetail = `Pre-period means differ by ${(maxSpread * 100).toFixed(1)}% — variants are not comparable.`; }
  }
  checks.push({ name: "pre_period_parity", severity: paritySev, detail: parityDetail, metric: { maxSpread } });

  // 4. Exposure leakage — control units seeing treatment content
  const leak = input.exposureLeakageRate;
  checks.push({
    name: "exposure_leakage",
    severity: leak <= 0.01 ? "pass" : leak <= 0.05 ? "warn" : "hard_fail",
    detail: leak <= 0.01
      ? `Exposure leakage ${(leak * 100).toFixed(2)}% — within tolerance.`
      : `Exposure leakage ${(leak * 100).toFixed(2)}% — the control is contaminated; the measured lift is attenuated.`,
    metric: { leakageRate: leak },
  });

  // 5. Concurrent-test contamination
  const risky = input.concurrentTests.filter((t) => t.directionRisk === "high" || t.overlap > 0.3);
  checks.push({
    name: "concurrent_tests",
    severity: risky.length === 0 ? "pass" : "warn",
    detail: risky.length === 0
      ? "No concurrent tests with dangerous audience overlap."
      : `${risky.length} concurrent test(s) overlap this audience (${risky.map((t) => t.testId).join(", ")}) — effects may not be attributable to this test.`,
  });

  // 6. Metric volatility — is the metric behaving normally during the test?
  const volRatio = input.volatility.historicalDailySd > 0
    ? input.volatility.observedDailySd / input.volatility.historicalDailySd
    : 1;
  checks.push({
    name: "metric_volatility",
    severity: volRatio <= 2 ? "pass" : volRatio <= 3 ? "warn" : "hard_fail",
    detail: volRatio <= 2
      ? "Metric volatility within historical band."
      : `Daily metric volatility is ${volRatio.toFixed(1)}× historical — results are unstable; investigate before reading.`,
    metric: { volatilityRatio: volRatio },
  });

  const hardFails = checks.filter((c) => c.severity === "hard_fail");
  const srmFailed = checks.some((c) => c.name === "srm" && c.severity === "hard_fail");
  return {
    checks,
    renderAllowed: !srmFailed,
    compromised: hardFails.length > 0,
  };
}

/** Verdict-line copy when rendering is refused. */
export function compromisedCopy(result: IntegrityBatteryResult): string {
  const failed = result.checks.filter((c) => c.severity === "hard_fail").map((c) => c.name);
  return `EXPERIMENT COMPROMISED — results refuse to render. Failing checks: ${failed.join(", ")}. ` +
    `Fix the underlying issue (or restart with clean randomization) before reading any numbers.`;
}
