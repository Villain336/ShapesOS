// Marketr — Phase 9 M2: shared executor guard rails.
//
// Every executor entry point runs checkKillSwitchesFirst() BEFORE touching
// any tool (SPEC §3.5). The tool allow-list is enforced by
// assertToolAllowed(): an executor asked to use anything outside its frozen
// TOOLS array throws ExecutorError — the allow-list is code, not a prompt.

import { isWorkspaceFrozen, isMissionPaused, KillSwitchError } from "../killswitch";

/** Re-exported so executors and tests share one halt type. */
export { KillSwitchError };

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorError";
  }
}

export interface GuardDeps {
  /** Kill-switch check #1: workspace freeze. Overridable for tests. */
  isWorkspaceFrozen?: (workspaceId: string) => Promise<boolean> | boolean;
  /** Kill-switch check #2: mission pause. Overridable for tests. */
  isMissionPaused?: (missionId: string, workspaceId: string) => Promise<boolean> | boolean;
}

export interface GuardedInput {
  workspaceId: string;
  missionId?: string | null;
}

/**
 * checkKillSwitchesFirst — runs at the top of EVERY executor entry point,
 * before any tool is touched. Frozen workspace or paused mission -> halt.
 * No exceptions, no fallbacks.
 */
export async function checkKillSwitchesFirst(
  input: GuardedInput,
  deps: GuardDeps = {},
): Promise<void> {
  const frozen = deps.isWorkspaceFrozen ?? isWorkspaceFrozen;
  const paused = deps.isMissionPaused ?? isMissionPaused;
  if (await frozen(input.workspaceId)) {
    throw new KillSwitchError(
      `Executor halted: workspace "${input.workspaceId}" is frozen. Unfreeze the workspace to resume.`,
    );
  }
  if (input.missionId && (await paused(input.missionId, input.workspaceId))) {
    throw new KillSwitchError(
      `Executor halted: mission "${input.missionId}" is paused. Resume the mission first.`,
    );
  }
}

/**
 * assertToolAllowed — the allow-list is a frozen array of permitted tool
 * names per executor. Anything else throws ExecutorError. Call this before
 * each tool use (or once up front for the tool set a run intends to use).
 */
export function assertToolAllowed(
  executorName: string,
  tools: readonly string[],
  tool: string,
): void {
  if (!tools.includes(tool)) {
    throw new ExecutorError(
      `${executorName}: tool "${tool}" is not in the allow-list [${tools.join(", ")}]. ` +
        `Executors can only use their declared tools.`,
    );
  }
}

/** Shared citation shape (ask endpoint + researcher results). */
export interface Citation {
  type: string;
  id: string;
  label: string;
}

/**
 * estimateCostCents — deterministic per-run cost model (illustrative rates,
 * documented, not measured): 0.3¢ per 1k input chars, 1.2¢ per 1k output
 * chars, minimum 1¢. Feeds the orchestrator's per-mission cost budget
 * (§3: termination checked in code, never by the LLM).
 */
export function estimateCostCents(charsIn: number, charsOut: number): number {
  const inCost = Math.ceil(Math.max(0, charsIn) / 1000) * 0.3;
  const outCost = Math.ceil(Math.max(0, charsOut) / 1000) * 1.2;
  return Math.max(1, Math.ceil(inCost + outCost));
}
