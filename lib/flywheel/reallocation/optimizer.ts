// Marketr — Phase 7 F1: marginal-ROAS equalization optimizer.
//
// The optimizer PROPOSES. It cannot touch money — proposals flow to the
// human approval queue (mode a) or the deterministic Policy Engine (mode b).
//
// Methodology per docs/specs/SPEC-PHASE7.md §2/F1:
// - Lag handling: optimize on attribution-lagged windows only (data-maturity
//   delay; never today's partials); require multi-window agreement (7d +
//   14–28d); measurement-health pre-check that FREEZES on degraded data.
// - Anti-churn: min meaningful shift (max 5–10% of channel budget, the
//   channel's learning-viable increment); ≤20% of channel daily budget per
//   step; 72h cool-down per channel; learning-viable floors.
// - 70-20-10 exploration slice the optimizer never touches; brand-capture
//   spend segmented out before marginal math.
// - v1 reallocates ONLY between platform campaigns — never inside
//   PMax/Advantage+ black boxes.

import { calibrationNote, fitMarginalCurve, type FitResult } from "./curves";
import {
  DEFAULT_TUNING,
  type ChannelFloor,
  type DataPoint,
  type DecisionRecord,
  type MarginalCurve,
  type OptimizerTuning,
  type ReallocationMode,
  type ReallocationProposal,
} from "./types";

export interface OptimizerChannel {
  channel: string;
  campaignRef: string; // the platform campaign whose budget moves (between-campaign v1)
  platform: string;
  currentDailyBudgetCents: number;
  targetCpaCents?: number;
  /** Brand-capture spend: segmented out of marginal math, never proposed. */
  isBrand: boolean;
  /** Inside the protected exploration slice: the optimizer may not touch. */
  isExploration: boolean;
  lastMoveAt?: string; // ISO — cool-down enforcement
  baselineDailyBudgetCents?: number; // band reference; defaults to current
  floor: ChannelFloor;
  /** Lagged, matured data points (optimizer ignores anything fresher than lagDays). */
  dataPoints: DataPoint[];
  /** Cross-source health signals for this channel. */
  health: ChannelHealth;
}

export interface ChannelHealth {
  eventVolume: number;
  expectedEventMean: number;
  expectedEventStd: number;
  platformSpendCents: number;
  trackerSpendCents: number;
}

export interface OptimizerResult {
  frozen: boolean;
  freezeReason?: string;
  proposals: ReallocationProposal[];
  curves: MarginalCurve[];
  healthSnapshot: Record<string, unknown>;
}

export interface OptimizerInput {
  workspaceId: string;
  mode: ReallocationMode;
  sraId?: string;
  channels: OptimizerChannel[];
  tuning?: Partial<OptimizerTuning>;
  now?: Date;
  idempotencySeed?: string;
}

let proposalSeq = 0;
const proposalId = (seed: string) =>
  `prop_${seed}_${Date.now().toString(36)}_${(proposalSeq++).toString(36)}`;

function windowPoints(points: DataPoint[], days: number, lagDays: number, now: Date): DataPoint[] {
  const newest = now.getTime() - lagDays * 86_400_000; // maturity delay — never today's partials
  const oldest = newest - days * 86_400_000;
  return points.filter((p) => {
    const t = +new Date(p.ts);
    return t >= oldest && t <= newest;
  });
}

/** Measurement-health pre-check: degraded source = FREEZE, not reallocate. */
export function checkMeasurementHealth(
  channels: OptimizerChannel[],
  tuning: OptimizerTuning,
): { ok: boolean; reasons: string[]; snapshot: Record<string, unknown> } {
  const reasons: string[] = [];
  const snapshot: Record<string, unknown> = {};
  for (const c of channels) {
    const h = c.health;
    const lo = h.expectedEventMean - tuning.healthSigma * h.expectedEventStd;
    const hi = h.expectedEventMean + tuning.healthSigma * h.expectedEventStd;
    const volumeOk = h.eventVolume >= lo && h.eventVolume <= hi;
    const denom = Math.max(1, h.trackerSpendCents);
    const disagreement = Math.abs(h.platformSpendCents - h.trackerSpendCents) / denom;
    const sourcesOk = disagreement <= tuning.crossSourceDisagreementPct;
    snapshot[c.channel] = { volumeOk, sourcesOk, disagreement: +disagreement.toFixed(4) };
    if (!volumeOk) {
      reasons.push(
        `${c.channel}: event volume ${h.eventVolume} outside ±${tuning.healthSigma}σ band [${lo.toFixed(0)}, ${hi.toFixed(0)}]`,
      );
    }
    if (!sourcesOk) {
      reasons.push(
        `${c.channel}: platform-vs-tracker spend disagreement ${(disagreement * 100).toFixed(1)}% exceeds ${(tuning.crossSourceDisagreementPct * 100).toFixed(0)}%`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons, snapshot };
}

interface ChannelFit {
  channel: OptimizerChannel;
  fits: Map<number, FitResult>; // windowDays -> fit
  marginalByWindow: Map<number, number>; // calibrated marginal ROAS
  marginal: number; // primary-window calibrated marginal
  curve: MarginalCurve; // primary-window curve (persisted)
}

/**
 * Run the optimizer. Deterministic; no LLM in this path — the math proposes,
 * the policy engine / human disposes.
 */
export function runOptimizer(input: OptimizerInput): OptimizerResult {
  const tuning: OptimizerTuning = { ...DEFAULT_TUNING, ...(input.tuning ?? {}) };
  const now = input.now ?? new Date();
  const seed = input.idempotencySeed ?? Math.random().toString(36).slice(2);

  // 0. Measurement-health pre-check — degraded data freezes the run.
  // Segmentation is computed first so the freeze snapshot still reports it.
  const eligible = input.channels.filter((c) => !c.isBrand && !c.isExploration);
  const segmented = input.channels.filter((c) => c.isBrand || c.isExploration);
  const segmentedOut = segmented.map((c) => c.channel);

  const health = checkMeasurementHealth(input.channels, tuning);
  if (!health.ok) {
    return {
      frozen: true,
      freezeReason: `measurement-health pre-check failed: ${health.reasons.join(" | ")}`,
      proposals: [],
      curves: [],
      healthSnapshot: { segmentedOut, ok: false, reasons: health.reasons, channels: health.snapshot },
    };
  }

  // 2. Fit per-channel curves on each window; require multi-window agreement.
  const fits: ChannelFit[] = [];
  const curves: MarginalCurve[] = [];
  for (const c of eligible) {
    const fitsByWindow = new Map<number, FitResult>();
    let ok = true;
    for (const w of tuning.windowsDays) {
      const pts = windowPoints(c.dataPoints, w, tuning.lagDays, now);
      if (pts.length < 5) {
        ok = false;
        break;
      }
      try {
        const fit = fitMarginalCurve({
          workspaceId: input.workspaceId,
          channel: c.channel,
          points: pts,
          dataWindow: `${w}d`,
        });
        fitsByWindow.set(w, fit);
      } catch {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const primary = tuning.windowsDays[0];
    const primaryFit = fitsByWindow.get(primary)!;
    const marginalByWindow = new Map<number, number>();
    for (const [w, f] of fitsByWindow) {
      marginalByWindow.set(w, f.calibratedMarginalAt(c.currentDailyBudgetCents));
    }
    const curve = { ...primaryFit.curve, id: `curve_${c.channel}_${seed}` };
    curves.push(curve);
    fits.push({
      channel: c,
      fits: fitsByWindow,
      marginalByWindow,
      marginal: marginalByWindow.get(primary)!,
      curve,
    });
  }
  if (fits.length < 2) {
    return {
      frozen: false,
      proposals: [],
      curves,
      healthSnapshot: { segmentedOut, ok: true, note: "fewer than 2 fittable channels — nothing to equalize" },
    };
  }

  // 3. Multi-window agreement: the source<dest ranking must hold in every
  //    window, or the pair is skipped (April-2026 GA4 lesson: never move on a
  //    single window's attribution delta).
  const proposals: ReallocationProposal[] = [];
  const ranked = [...fits].sort((a, b) => a.marginal - b.marginal);
  const source = ranked[0];
  const dest = ranked[ranked.length - 1];
  if (source.marginal >= dest.marginal) {
    return {
      frozen: false,
      proposals: [],
      curves,
      healthSnapshot: { segmentedOut, ok: true, note: "marginals already equalized — no move" },
    };
  }
  let agreement = true;
  let stabilityNote = "";
  for (const w of tuning.windowsDays) {
    if (source.marginalByWindow.get(w)! >= dest.marginalByWindow.get(w)!) {
      agreement = false;
      break;
    }
  }
  // Per-channel cross-window stability: a single window's attribution delta
  // (e.g. a 3x revenue spike confined to the 7d window) must not move money,
  // even when the source<dest ranking technically holds in every window.
  if (agreement) {
    for (const f of fits) {
      const ms = [...f.marginalByWindow.values()];
      const mx = Math.max(...ms);
      const mn = Math.min(...ms);
      if (mx > 1e-9 && mn > 0 && mx / mn > tuning.crossWindowStabilityRatio) {
        agreement = false;
        stabilityNote = `${f.channel.channel} marginal unstable across windows (${mn.toFixed(2)}x–${mx.toFixed(2)}x, ratio ${(mx / mn).toFixed(2)} > ${tuning.crossWindowStabilityRatio})`;
        break;
      }
    }
  }

  const decisionRecordBase = (mSrc: number, mDst: number): DecisionRecord => {
    const calib = source.curve.iroasCalibrationFactor ?? dest.curve.iroasCalibrationFactor;
    const platformSrc = source.fits.get(tuning.windowsDays[0])!.marginalAt(source.channel.currentDailyBudgetCents);
    return {
      dataWindow: tuning.windowsDays.map((w) => `${w}d`).join("+"),
      lagDays: tuning.lagDays,
      curveParams: { [source.channel.channel]: source.curve, [dest.channel.channel]: dest.curve },
      multiWindowAgreement: agreement,
      measurementHealth: "ok",
      marginalRoasSource: +mSrc.toFixed(4),
      marginalRoasDest: +mDst.toFixed(4),
      marginalRoasDelta: +(mDst - mSrc).toFixed(4),
      calibrationNote: calib
        ? calibrationNote(platformSrc, mSrc)
        : undefined,
      modelVersion: source.curve.modelVersion,
      rationale:
        `Move budget from ${source.channel.channel} (marginal ${mSrc.toFixed(2)}x) to ` +
        `${dest.channel.channel} (marginal ${mDst.toFixed(2)}x). ` +
        `Ranking holds across ${tuning.windowsDays.join("d/")}d windows with ${tuning.lagDays}d maturity lag.`,
    };
  };

  if (!agreement) {
    return {
      frozen: false,
      proposals: [],
      curves,
      healthSnapshot: { segmentedOut, ok: true, note: stabilityNote || "multi-window disagreement — no proposal", decisionRecord: decisionRecordBase(source.marginal, dest.marginal) },
    };
  }

  // 4. Size the step with anti-churn guards.
  const srcBudget = source.channel.currentDailyBudgetCents;
  const minShift = Math.max(
    tuning.minShiftPct * srcBudget,
    source.channel.floor.learningViableMinCentsDay * 0.1, // the channel's learning-viable increment
  );
  const maxStep = tuning.maxStepPct * srcBudget;

  // Cool-down: no channel moved in the last `cooldownHours` may move again.
  const cooldownMs = tuning.cooldownHours * 3_600_000;
  const srcCooled = !source.channel.lastMoveAt || now.getTime() - +new Date(source.channel.lastMoveAt) >= cooldownMs;
  const dstCooled = !dest.channel.lastMoveAt || now.getTime() - +new Date(dest.channel.lastMoveAt) >= cooldownMs;
  if (!srcCooled || !dstCooled) {
    return {
      frozen: false,
      proposals: [],
      curves,
      healthSnapshot: { segmentedOut,
        ok: true,
        note: "cool-down active — no proposal",
        sourceCooled: srcCooled,
        destCooled: dstCooled,
      },
    };
  }

  // Learning-viable floors: refuse to drain a channel below its floor.
  const srcFloor = source.channel.floor.learningViableMinCentsDay;
  const headroom = srcBudget - srcFloor;
  if (headroom <= 0) {
    return {
      frozen: false,
      proposals: [],
      curves,
      healthSnapshot: { segmentedOut, ok: true, note: `${source.channel.channel} at learning-viable floor — no headroom` },
    };
  }
  let amount = Math.min(maxStep, headroom);
  if (amount < minShift) {
    return {
      frozen: false,
      proposals: [],
      curves,
      healthSnapshot: { segmentedOut,
        ok: true,
        note: `sub-threshold move (${(amount / 100).toFixed(2)} < min ${(minShift / 100).toFixed(2)}) — learning resets cost more than the gain`,
      },
    };
  }
  amount = Math.round(amount);

  const dr = decisionRecordBase(source.marginal, dest.marginal);
  proposals.push({
    id: proposalId(seed),
    workspaceId: input.workspaceId,
    mode: input.mode,
    sraId: input.sraId ?? null,
    sourceChannel: source.channel.channel,
    destChannel: dest.channel.channel,
    sourceCampaignRef: source.channel.campaignRef,
    destCampaignRef: dest.channel.campaignRef,
    amountCents: amount,
    marginalRoasDelta: dr.marginalRoasDelta,
    decisionRecord: dr,
    status: "proposed",
    humanApprovalId: null,
    createdAt: now.toISOString(),
  });

  return {
    frozen: false,
    proposals,
    curves,
    healthSnapshot: { segmentedOut,
      ok: true,
      channels: health.snapshot,
    },
  };
}
