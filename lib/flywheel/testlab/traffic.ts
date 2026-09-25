// Marketr — Test Lab traffic-floor math (F3).
//
// The lab REFUSES small-tweak tests at low-traffic sites: it states the
// minimum detectable effect the traffic can support and suggests qualitative
// methods or big swings instead. (Spec §2/F3.)
//
// Math: two-sample binomial, 80% power, two-sided α=0.05.

import { normalInv, fmtPct } from "./stats";

export const POWER = 0.8;
export const ALPHA = 0.05;

/** Sample size PER ARM to detect a relative lift with the given power. */
export function sampleSizePerArm(baselineRate: number, relativeLift: number, power = POWER, alpha = ALPHA): number {
  const p1 = baselineRate;
  const p2 = baselineRate * (1 + relativeLift);
  if (p1 <= 0 || p1 >= 1 || p2 <= 0 || p2 >= 1) return Infinity;
  const zA = normalInv(1 - alpha / 2);
  const zB = normalInv(power);
  const pBar = (p1 + p2) / 2;
  const n = (
    (zA * Math.sqrt(2 * pBar * (1 - pBar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2
  ) / ((p2 - p1) ** 2);
  return Math.ceil(n);
}

/** Minimum DETECTABLE relative lift given per-arm traffic at the target power. */
export function detectableLift(perArmTraffic: number, baselineRate: number, power = POWER, alpha = ALPHA): number {
  const zA = normalInv(1 - alpha / 2);
  const zB = normalInv(power);
  // solve |p2 - p1| ≈ (zA√(2 p̄(1-p̄)) + zB√(p1(1-p1)+p2(1-p2))) / √n, iterate
  let lift = 0.5;
  for (let it = 0; it < 60; it++) {
    const p1 = baselineRate;
    const p2 = baselineRate * (1 + lift);
    if (p2 >= 1) { lift *= 0.9; continue; }
    const pBar = (p1 + p2) / 2;
    const needed = (
      (zA * Math.sqrt(2 * pBar * (1 - pBar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2
    ) / ((p2 - p1) ** 2);
    lift = needed > perArmTraffic ? lift * 1.05 : lift * 0.97;
  }
  return lift;
}

/** Weeks to reach the needed per-arm sample at the site's weekly traffic. */
export function weeksToDetect(perArmNeeded: number, weeklyTraffic: number, armShare = 0.5): number {
  const perArmPerWeek = weeklyTraffic * armShare;
  if (perArmPerWeek <= 0) return Infinity;
  return perArmNeeded / perArmPerWeek;
}

export interface TrafficFloorInput {
  baselineRate: number;
  monthlyTraffic: number;
  /** the lift the user hopes to detect (relative), e.g. 0.2 */
  hopedLift: number;
  /** share of traffic the test gets (A/B split), e.g. 0.5 per arm */
  armShare?: number;
  /** stated MDE the user is willing to accept */
  statedMde?: number;
}

export interface TrafficFloorVerdict {
  decision: "proceed" | "rightsize" | "refuse";
  detectableLift: number;
  weeksNeeded: number;
  note: string;
  suggestions: string[];
}

/**
 * The traffic-floor honesty check. Refuses tests the traffic cannot support.
 *
 * Reference math (80% power): a 5k-visitors/mo site at 2% baseline needs
 * ~8.4 months to detect a 20% lift.
 */
export function trafficFloorCheck(input: TrafficFloorInput): TrafficFloorVerdict {
  const { baselineRate, monthlyTraffic, hopedLift } = input;
  const armShare = input.armShare ?? 0.5;
  const weeklyTraffic = monthlyTraffic / 4.345;
  const perArmPerWeek = weeklyTraffic * armShare;

  const mde = detectableLift(perArmPerWeek * 12, baselineRate); // at ~12 weeks runway
  const needed = sampleSizePerArm(baselineRate, hopedLift);
  const weeks = weeksToDetect(needed, weeklyTraffic, armShare);

  const suggestions = [
    "Run qualitative research (session recordings, user interviews, usability tests) — it finds big wins without statistical power.",
    "Test BIG swings instead of small tweaks: redesigns, offer changes, and pricing tests move the needle enough to detect.",
    "Pool traffic across pages or lengthen the runtime — but never read a test before one full business cycle.",
  ];

  if (!isFinite(needed) || !isFinite(weeks)) {
    return {
      decision: "refuse", detectableLift: mde, weeksNeeded: weeks,
      note: "This site does not have enough traffic to run a credible A/B test on this metric.",
      suggestions,
    };
  }

  if (weeks > 12) {
    return {
      decision: "refuse",
      detectableLift: mde,
      weeksNeeded: weeks,
      note: `You can only detect a ≥${fmtPct(mde)} lift with this traffic in a reasonable window — ` +
        `detecting ${fmtPct(hopedLift)} would take ~${weeks.toFixed(1)} weeks. The lab refuses to run a test it cannot resolve.`,
      suggestions,
    };
  }
  if (weeks > 6 || mde > hopedLift * 1.5) {
    return {
      decision: "rightsize",
      detectableLift: mde,
      weeksNeeded: weeks,
      note: `Detectable in ~${weeks.toFixed(1)} weeks, but only lifts ≥${fmtPct(mde)} will resolve. ` +
        `Right-size the hypothesis to a bigger swing, or accept INCONCLUSIVE risk.`,
      suggestions: suggestions.slice(1),
    };
  }
  return {
    decision: "proceed",
    detectableLift: mde,
    weeksNeeded: weeks,
    note: `Traffic supports a ${fmtPct(hopedLift)} lift in ~${weeks.toFixed(1)} weeks. Minimum runtime still ≥1 full business cycle.`,
    suggestions: [],
  };
}
