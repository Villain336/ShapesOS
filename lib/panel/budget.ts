// ShapesOS — Phase 19B (WS=panel): the HARD per-run credit cap.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Ported from the prototype's src/llm/costs.ts (CostLedger). The prototype
// priced calls in USD from its own table and threw AFTER a call pushed the run
// over budget, so the last call could overshoot and the throw was swallowed
// by the proposition hooks. Here:
//
//   * money is ShapesOS credits, priced by the router's own tables:
//     credits(call) = llmTokenCredits(billableCostMicroUsd(model, usage)) —
//     the same rule lib/llm/usage.ts charges (1.5× provider cost; an unknown
//     price is billed at the most expensive known rate, never 0). The cap
//     counts LIST credits even on a workspace's own key (BYOK), so it also
//     caps the provider bill the founder pays directly;
//   * BEFORE every call the ledger RESERVES the call's worst case (input
//     estimated from the prompt's characters with a safety margin, output =
//     its maxTokens, which the provider enforces). If spent + reserved +
//     this reservation would pass the cap, the call is never sent and
//     PanelCapReachedError is thrown — the run stops cleanly with what it
//     has (an honest partial result);
//   * AFTER the call the reservation is replaced by the actual credits.
//   Because a reservation is a ceiling, spent never passes the cap.
//
// Cap maths (shown to the person before the run, lib/panel/estimate.ts):
//   per persona  = stepCap × (step call + 2 judge calls) + 1 verdict call
//   per run      = Σ personas + FIX_CLUSTER_CAP fix calls
//   each call    = credits(model, inputTokens ≈ promptChars / 3 × 1.2, outputTokens = maxTokens)
// The estimate is an upper bound: most walks end before stepCap and most
// replies are shorter than maxTokens.

import { billableCostMicroUsd } from "@/lib/llm/pricing";
import { llmTokenCredits } from "@/lib/metering/credits";

/** Characters per token used for the input estimate (conservative: real text runs ~3.5–4). */
export const CHARS_PER_TOKEN = 3;
/** Safety margin on the input estimate. */
export const INPUT_MARGIN = 1.2;

export function estimateInputTokens(promptChars: number): number {
  return Math.ceil((Math.max(0, promptChars) / CHARS_PER_TOKEN) * INPUT_MARGIN);
}

/** List credits of one call's usage on a model (the router's billing rule). */
export function creditsForUsage(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
  const { costMicroUsd } = billableCostMicroUsd(model, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  });
  return llmTokenCredits(costMicroUsd);
}

/** Worst-case credits of a call before it is sent. */
export function worstCaseCallCredits(model: string, promptChars: number, maxTokens: number): number {
  return creditsForUsage(model, { inputTokens: estimateInputTokens(promptChars), outputTokens: Math.max(0, maxTokens) });
}

export class PanelCapReachedError extends Error {
  readonly runId: string;
  readonly capCredits: number;
  readonly spentCredits: number;
  readonly neededCredits: number;
  constructor(runId: string, capCredits: number, spentCredits: number, neededCredits: number) {
    super(
      `Run ${runId} stopped at its credit cap: ${spentCredits} of ${capCredits} credits spent; the next model call could need up to ${neededCredits} more.`,
    );
    this.name = "PanelCapReachedError";
    this.runId = runId;
    this.capCredits = capCredits;
    this.spentCredits = spentCredits;
    this.neededCredits = neededCredits;
  }
}

export function isCapReached(err: unknown): err is PanelCapReachedError {
  return err instanceof PanelCapReachedError || (err instanceof Error && err.name === "PanelCapReachedError");
}

export interface RunSpend {
  runId: string;
  capCredits: number;
  spentCredits: number;
  reservedCredits: number;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls refused at the cap (0 or 1: the run stops at the first). */
  refusedCalls: number;
}

interface RunState extends RunSpend {
  perModel: Record<string, { calls: number; credits: number }>;
  perPurpose: Record<string, { calls: number; credits: number }>;
}

export interface Reservation {
  runId: string;
  credits: number;
  settled: boolean;
}

/**
 * Per-run credit ledger with a hard cap. In-process and synchronous, so
 * personas walking in parallel can never reserve past the cap together.
 *
 *   const ledger = new PanelLedger();
 *   ledger.beginRun("run-1", 120);
 *   const r = ledger.reserve("run-1", worstCase);   // throws PanelCapReachedError
 *   …call the model…
 *   ledger.settle(r, "claude-haiku-4-5", usage, "step");
 */
export class PanelLedger {
  private runs = new Map<string, RunState>();

  beginRun(runId: string, capCredits: number): void {
    if (!Number.isFinite(capCredits) || capCredits < 0) throw new Error("capCredits must be >= 0");
    if (this.runs.has(runId)) throw new Error(`Run ${runId} already begun`);
    this.runs.set(runId, {
      runId,
      capCredits: Math.floor(capCredits),
      spentCredits: 0,
      reservedCredits: 0,
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      refusedCalls: 0,
      perModel: {},
      perPurpose: {},
    });
  }

  private state(runId: string): RunState {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run ${runId} — call beginRun first`);
    return run;
  }

  /** Hold `credits` for a call about to be sent; throws PanelCapReachedError when it would pass the cap. */
  reserve(runId: string, credits: number): Reservation {
    const run = this.state(runId);
    const need = Math.max(0, Math.ceil(credits));
    if (run.spentCredits + run.reservedCredits + need > run.capCredits) {
      run.refusedCalls += 1;
      throw new PanelCapReachedError(runId, run.capCredits, run.spentCredits, need);
    }
    run.reservedCredits += need;
    return { runId, credits: need, settled: false };
  }

  /** Replace a reservation with the call's actual credits. */
  settle(reservation: Reservation, model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }, purpose = "call"): number {
    const run = this.state(reservation.runId);
    if (reservation.settled) throw new Error("reservation already settled");
    reservation.settled = true;
    run.reservedCredits = Math.max(0, run.reservedCredits - reservation.credits);
    const credits = creditsForUsage(model, usage);
    run.spentCredits += credits;
    run.callCount += 1;
    run.inputTokens += usage.inputTokens;
    run.outputTokens += usage.outputTokens;
    const pm = (run.perModel[model] ??= { calls: 0, credits: 0 });
    pm.calls += 1;
    pm.credits += credits;
    const pp = (run.perPurpose[purpose] ??= { calls: 0, credits: 0 });
    pp.calls += 1;
    pp.credits += credits;
    return credits;
  }

  /** Give a reservation back (the call was never made, e.g. it failed before sending). */
  release(reservation: Reservation): void {
    if (reservation.settled) return;
    reservation.settled = true;
    const run = this.state(reservation.runId);
    run.reservedCredits = Math.max(0, run.reservedCredits - reservation.credits);
  }

  /** Throws when the run has nothing left for a call of `credits`. */
  assertRoom(runId: string, credits = 0): void {
    const run = this.state(runId);
    if (run.spentCredits + run.reservedCredits + Math.max(0, credits) > run.capCredits) {
      throw new PanelCapReachedError(runId, run.capCredits, run.spentCredits, credits);
    }
  }

  spend(runId: string): RunSpend {
    const { perModel: _m, perPurpose: _p, ...rest } = this.state(runId);
    return { ...rest };
  }

  spendByModel(runId: string): Record<string, { calls: number; credits: number }> {
    return structuredClone(this.state(runId).perModel);
  }

  spendByPurpose(runId: string): Record<string, { calls: number; credits: number }> {
    return structuredClone(this.state(runId).perPurpose);
  }
}
