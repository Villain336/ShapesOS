// Marketr — Test Lab honesty dashboard (F3).
//
// Peek-safe decision boundaries. This module NEVER uses "significant" or
// "significance" — it speaks in deploy decisions, expected loss, and maturity.
// Per spec §9 invariant 10: underpowered tests = INCONCLUSIVE with the
// detectable-lift math stated; conversion tests without profit guardrails
// don't launch; Bayesian early-reads are gated on expected loss + minimum data.

import {
  bayesianBinomial, bayesianGaussian, sequentialTest, frequentistTest,
  frequentistDiff, frequentistVariance,
  binomialToGaussian, fmtPct, type BinomialArm, type GaussianArm,
} from "./stats";
import { sampleSizePerArm, detectableLift } from "./traffic";
import type { IntegrityBatteryResult } from "./integrity";

export type Verdict = "winner" | "loser" | "inconclusive" | "compromised";

export interface PowerBadge { label: "powered" | "underpowered"; detail: string }
export interface MaturityBadge { label: "immature" | "maturing" | "mature"; detail: string }
export interface IntegrityBadge { label: "clean" | "warnings" | "compromised"; detail: string }

export interface GuardrailCheck {
  name: string;
  /** relative change vs control (negative = regression for most) */
  relativeChange: number;
  /** worst acceptable regression, e.g. 0.05 = 5% */
  tolerance: number;
  violated: boolean;
}

export interface HonestyInput {
  metricType: "binomial" | "gaussian";
  armA: BinomialArm | GaussianArm;
  armB: BinomialArm | GaussianArm;
  /** stated minimum detectable effect (relative) */
  statedMde: number;
  /** minimum runtime in days (≥7) */
  minRuntimeDays: number;
  /** days the test has actually been running */
  daysRunning: number;
  /** does the elapsed window cover ≥1 full business cycle? */
  fullCycleCovered: boolean;
  /** guardrail metrics evaluated */
  guardrails: GuardrailCheck[];
  /** expected-loss deploy threshold (relative, e.g. 0.005 = 0.5% of baseline) */
  expectedLossThreshold: number;
  /** minimum total units before any read (e.g. 500) */
  minUnits: number;
  /** is the primary metric revenue/profit-affecting (profit guardrail mandatory)? */
  conversionTest: boolean;
  /** profit check result — required when conversionTest */
  profitCheck?: { profitUplift: number; profitLoss: number };
}

export interface HonestyResult {
  verdict: Verdict;
  /** terminal only when integrity clean + mature + powered */
  terminal: boolean;
  chanceToBeat: number;
  expectedLossRelative: number;
  expectedUplift: number;
  ci: [number, number];
  /** always-valid sequential CI — the peek-safe read */
  sequentialCi: [number, number];
  sequentialExcludesNull: boolean;
  frequentistP: number;
  badges: { power: PowerBadge; maturity: MaturityBadge; integrity: IntegrityBadge };
  guardrailViolations: string[];
  /** why INCONCLUSIVE / what to do next */
  guidance: string[];
  /** the honest headline — no "significance" language */
  headline: string;
}

/** Benjamini–Hochberg FDR correction for secondary/exploratory metrics. */
export function fdrCorrect(pValues: number[], fdr = 0.1): boolean[] {
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = pValues.length;
  const sig = new Array<boolean>(m).fill(false);
  let maxK = 0;
  for (let k = 1; k <= m; k++) {
    if (indexed[k - 1].p <= (k / m) * fdr) maxK = k;
  }
  for (let k = 0; k < maxK; k++) sig[indexed[k].i] = true;
  return sig;
}

export function powerBadge(input: HonestyInput): PowerBadge {
  const nA = "trials" in input.armA ? input.armA.trials : input.armA.n;
  const nB = "trials" in input.armB ? input.armB.trials : input.armB.n;
  const perArm = Math.min(nA, nB);
  const baseRate = "trials" in input.armA && input.armA.trials > 0
    ? input.armA.successes / input.armA.trials
    : 0.05;
  const mde = input.metricType === "binomial"
    ? detectableLift(perArm, baseRate)
    : detectableLift(perArm, baseRate);
  if (mde <= input.statedMde) {
    return { label: "powered", detail: `Powered for the stated MDE of ${fmtPct(input.statedMde)} (current detectable: ${fmtPct(mde)}).` };
  }
  return {
    label: "underpowered",
    detail: `Underpowered: with current traffic you can only detect ≥${fmtPct(mde)} lifts, but the stated MDE is ${fmtPct(input.statedMde)}. ` +
      `Needed per arm for ${fmtPct(input.statedMde)}: ~${sampleSizePerArm(baseRate || 0.05, input.statedMde).toLocaleString()} units.`,
  };
}

export function maturityBadge(input: HonestyInput): MaturityBadge {
  const nTotal = ("trials" in input.armA ? input.armA.trials : input.armA.n) +
    ("trials" in input.armB ? input.armB.trials : input.armB.n);
  if (input.daysRunning < input.minRuntimeDays || !input.fullCycleCovered) {
    return {
      label: "immature",
      detail: `Day ${input.daysRunning} of ${input.minRuntimeDays} minimum — novelty/primacy effects are still in play. ` +
        `No read is trustworthy before one full business cycle.`,
    };
  }
  if (nTotal < input.minUnits) {
    return {
      label: "maturing",
      detail: `Full cycle covered, but only ${nTotal.toLocaleString()} units so far (minimum ${input.minUnits.toLocaleString()}). Keep running.`,
    };
  }
  return { label: "mature", detail: "Minimum runtime, full business cycle, and minimum data all met." };
}

export function honestyRead(
  input: HonestyInput,
  integrity: IntegrityBatteryResult,
): HonestyResult {
  const guidance: string[] = [];
  const guardrailViolations = input.guardrails.filter((g) => g.violated).map((g) => g.name);

  const integrityBadge: IntegrityBadge = !integrity.renderAllowed || integrity.compromised
    ? { label: "compromised", detail: "Integrity battery failed — numbers are not shown." }
    : integrity.checks.some((c) => c.severity === "warn")
      ? { label: "warnings", detail: "Integrity warnings present — read the result with the caveats below." }
      : { label: "clean", detail: "Integrity battery clean." };

  if (!integrity.renderAllowed) {
    return {
      verdict: "compromised", terminal: true,
      chanceToBeat: 0.5, expectedLossRelative: 0, expectedUplift: 0,
      ci: [0, 0], sequentialCi: [0, 0], sequentialExcludesNull: false, frequentistP: 1,
      badges: { power: powerBadge(input), maturity: maturityBadge(input), integrity: integrityBadge },
      guardrailViolations, guidance: ["Fix the integrity failure before reading anything."],
      headline: "EXPERIMENT COMPROMISED — results refuse to render.",
    };
  }

  // Core inference
  let chanceToBeat = 0.5, expectedLossRelative = 0, expectedUplift = 0;
  let ci: [number, number] = [0, 0];
  let freqP = 1;
  let seq = { confidenceInterval: [0, 0] as [number, number], pValue: 1, rho: 0, excludesNull: false };
  if (input.metricType === "binomial") {
    const r = bayesianBinomial(input.armA as BinomialArm, input.armB as BinomialArm);
    chanceToBeat = r.chanceToBeat;
    expectedLossRelative = r.expectedLossRelative;
    expectedUplift = r.expectedUplift;
    ci = r.credibleInterval;
    const gA = binomialToGaussian(input.armA as BinomialArm);
    const gB = binomialToGaussian(input.armB as BinomialArm);
    freqP = frequentistTest(gA, gB, { relative: true }).pValue;
    const diff = (gB.mean - gA.mean) / (gA.mean || 1);
    const v = gB.variance / ((gA.mean ** 2) * gB.n) + (gA.variance * gB.mean ** 2) / ((gA.mean ** 4) * gA.n || 1);
    seq = sequentialTest(diff, v || 1e-12, gA.n + gB.n);
  } else {
    const r = bayesianGaussian(input.armA as GaussianArm, input.armB as GaussianArm, { relative: true });
    chanceToBeat = r.chanceToWin;
    expectedLossRelative = Math.max(r.expectedLoss[0], r.expectedLoss[1]);
    expectedUplift = r.expected;
    ci = r.credibleInterval;
    freqP = frequentistTest(input.armA as GaussianArm, input.armB as GaussianArm, { relative: true }).pValue;
    const gA2 = input.armA as GaussianArm, gB2 = input.armB as GaussianArm;
    const diff = frequentistDiff(gA2.mean, gB2.mean, true);
    const v = frequentistVariance(gA2.variance, gA2.mean, gA2.n, gB2.variance, gB2.mean, gB2.n, true);
    seq = sequentialTest(diff, v || 1e-12, gA2.n + gB2.n);
  }

  const power = powerBadge(input);
  const maturity = maturityBadge(input);

  // Profit guardrail (mandatory on conversion tests): a conversion lift with a
  // discount can be a loss. If missing or violated, no winner may be declared.
  const profitOk = !input.conversionTest ||
    (input.profitCheck !== undefined && input.profitCheck.profitLoss <= input.expectedLossThreshold && input.profitCheck.profitUplift >= 0);

  // Verdict logic — peek-safe: sequential boundary + Bayesian expected loss,
  // never posterior probability alone, never before maturity+power.
  let verdict: Verdict = "inconclusive";
  let terminal = false;
  if (guardrailViolations.length > 0 || !profitOk) {
    verdict = "inconclusive"; terminal = true;
    guidance.push(
      guardrailViolations.length > 0
        ? `Guardrail violated: ${guardrailViolations.join(", ")}. Do not deploy — the primary metric won at the cost of something that matters.`
        : "Profit guardrail failed: the conversion lift does not survive the margin check. Do not deploy.",
    );
  } else if (maturity.label !== "mature") {
    verdict = "inconclusive"; terminal = false;
    guidance.push(maturity.detail);
    guidance.push("The sequential interval below is peek-safe to *monitor*, but no deploy decision may be taken yet.");
  } else if (power.label === "underpowered") {
    verdict = "inconclusive"; terminal = true;
    guidance.push(power.detail);
    guidance.push("This test cannot resolve its stated MDE. Archive as INCONCLUSIVE — do not keep it running hoping noise becomes truth.");
  } else {
    terminal = true;
    const deployable = chanceToBeat >= 0.95 &&
      expectedLossRelative <= input.expectedLossThreshold &&
      seq.excludesNull;
    const harmful = (1 - chanceToBeat) >= 0.95 &&
      expectedLossRelative <= input.expectedLossThreshold &&
      seq.excludesNull;
    if (deployable) {
      verdict = "winner";
      guidance.push(
        `Deploy criteria met: chance to beat ${(chanceToBeat * 100).toFixed(1)}%, ` +
        `expected loss ${fmtPct(expectedLossRelative, 2)} ≤ threshold ${fmtPct(input.expectedLossThreshold, 2)}, ` +
        `and the always-valid sequential interval excludes zero — so this read is valid despite peeking.`,
      );
    } else if (harmful) {
      verdict = "loser";
      guidance.push("The treatment is reliably worse than control. Roll back and archive the learning.");
    } else {
      verdict = "inconclusive";
      guidance.push(
        `Chance to beat is ${(chanceToBeat * 100).toFixed(1)}% — below the 95% deploy bar, or the expected loss ` +
        `exceeds the threshold. The honest answer is: we don't know yet. Do not deploy on hope.`,
      );
    }
  }

  // Note: "compromised" returns early above (integrity gate) and never reaches here.
  const headline = verdict === "winner"
    ? `READY TO DEPLOY — expected uplift ${fmtPct(expectedUplift)} (95% CI ${fmtPct(ci[0])} to ${fmtPct(ci[1])}), expected loss within tolerance.`
    : verdict === "loser"
      ? `ROLL BACK — treatment reliably underperforms (expected ${fmtPct(expectedUplift)}).`
      : terminal
        ? `INCONCLUSIVE — ${guidance[0] ?? "the data cannot support a deploy decision."}`
        : `STILL READING — ${maturity.detail}`;

  return {
    verdict, terminal, chanceToBeat, expectedLossRelative, expectedUplift, ci,
    sequentialCi: seq.confidenceInterval, sequentialExcludesNull: seq.excludesNull,
    frequentistP: freqP,
    badges: { power, maturity, integrity: integrityBadge },
    guardrailViolations, guidance, headline,
  };
}
