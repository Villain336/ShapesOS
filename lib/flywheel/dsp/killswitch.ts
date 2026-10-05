// Marketr — Phase 7 F5: kill-switch ↔ pause-API mapping.
//
// Phase 5's per-platform kill-switch actions (pause | reduce_budget | alert)
// become REAL pause calls wherever a seat-connected adapter exists. Where no
// seat exists, the mapping returns an HONEST no-op — never a fake "paused".
// This is where Phase 5's fake no-ops get their real targets behind the
// adapter interface; without a seat they stay honestly unexecuted.

import { DspAdapter, DspKind, DspOpResult, SeatNotConnectedError, DSP_LABELS } from "./types";
import type { KillAction } from "../../media/killswitch";

export interface DspKillTarget {
  dsp: DspKind;
  platformRef: string;
  campaignName: string;
}

export interface DspKillResult extends DspOpResult {
  /** True only when the platform actually paused/capped something. */
  reallyExecuted: boolean;
  /** Present when the action was NOT executed — the honest reason. */
  honestReason: string | null;
  killRuleId: string;
  killRuleName: string;
}

/**
 * Execute one kill-switch action against a DSP target through the adapter.
 * - seat connected → real adapter call (pause / setCap); alert stays a human alert.
 * - no seat → honest no-op: { executed: false, honestReason } with
 *   "connect your agency seat" guidance. The kill-switch's non-DSP paths
 *   (pools, native rules) remain the backstop.
 */
export async function executeDspKillAction(
  adapter: DspAdapter,
  action: KillAction,
  target: DspKillTarget,
  opts: {
    killRuleId: string;
    killRuleName: string;
    actor: string;
    reduceBudgetCapCents?: number;
    capApprovalId?: string;
  },
): Promise<DspKillResult> {
  const base = {
    killRuleId: opts.killRuleId,
    killRuleName: opts.killRuleName,
    platformRef: target.platformRef,
  };

  if (action === "alert") {
    // Alerts are human actions by definition — there is no platform call.
    return {
      ...base,
      executed: false,
      outcome: "not_supported",
      detail: `Alert "${opts.killRuleName}" surfaced to the human. No platform action exists for alerts.`,
      reallyExecuted: false,
      honestReason: "alert-only: a human must act; no platform pause is implied.",
    };
  }

  try {
    const op: DspOpResult =
      action === "pause"
        ? await adapter.pause({ platformRef: target.platformRef, reason: `kill rule: ${opts.killRuleName}`, actor: opts.actor })
        : await adapter.setCap({
            platformRef: target.platformRef,
            capCents: opts.reduceBudgetCapCents ?? 0,
            approvalId: opts.capApprovalId ?? "",
          });
    return {
      ...base,
      ...op,
      reallyExecuted: op.executed,
      honestReason: op.executed ? null : op.detail,
    };
  } catch (err) {
    if (err instanceof SeatNotConnectedError) {
      return {
        ...base,
        executed: false,
        platformRef: target.platformRef,
        outcome: "not_connected",
        detail: err.guidance,
        reallyExecuted: false,
        // Honest no-op: Marketr cannot pause this buy — alerts only.
        honestReason:
          `ShapesOS cannot pause this ${DSP_LABELS[adapter.kind]} buy: no agency seat connected. ` +
          `The human must pause it in the DSP UI. Guidance: ${err.guidance}`,
      };
    }
    throw err;
  }
}

/**
 * All-or-nothing sweep helper for a client: pause every live DSP target.
 * Returns per-target results — partial failure is reported per target, never
 * masked, so the human knows exactly which buys are still live.
 */
export async function pauseAllDspTargets(
  targets: Array<{ adapter: DspAdapter; target: DspKillTarget }>,
  opts: { killRuleId: string; killRuleName: string; actor: string },
): Promise<DspKillResult[]> {
  return Promise.all(
    targets.map(({ adapter, target }) =>
      executeDspKillAction(adapter, "pause", target, opts),
    ),
  );
}

/** reduce_budget requires an explicit cap and its backing approval id. */
export function assertReduceBudgetArgs(capCents: number | undefined, approvalId: string | undefined): void {
  if (!capCents || !Number.isInteger(capCents) || capCents <= 0) {
    throw new Error("reduce_budget requires a positive integer reduceBudgetCapCents.");
  }
  if (!approvalId) {
    throw new Error("reduce_budget requires capApprovalId — the human-signed approval backing the new cap.");
  }
}
