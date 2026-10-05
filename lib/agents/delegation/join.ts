// ShapesOS — Phase 16: transcript patches for delegation (PURE: state in,
// state out; the callers load / save it through lib/agents/runs/transcript).
//
//   applyJoinToState — the join: a joined plan's placeholder tool_result is
//     replaced by the merge report (every task's deliverable), the children's
//     real spend is added to the delegating run's cost, the delegate call's
//     summary says how it went, and the merge keeps its reserved time. Each
//     plan is applied once (state.appliedPlans).
//   patchDecidedProposals — the user decided on a waiting run's proposals
//     ("yes" ran them, or a new message declined them): their tool_results
//     carry the real outcome, their call records follow, the run's outcome
//     is cleared so it can carry on, and the time it spent waiting for the
//     person is not counted against its own time budget.

import type { ChatToolResultBlock } from "@/lib/llm/types";
import type { ChatToolCall } from "@/lib/chat/tool-exec";
import type { LoopState } from "@/lib/agents/loop";
import { delegationProgress, isWaitingPlaceholder, joinReport, progressLine, type DelegationPlanState } from "./plan";

export function applyJoinToState(
  s: LoopState,
  plans: readonly DelegationPlanState[],
  opts: { now: number; maxMs: number },
): string[] {
  const applied = new Set(s.appliedPlans ?? []);
  const done: string[] = [];
  for (const plan of plans) {
    if (!plan.joinedAt || applied.has(plan.planId)) continue;
    const report = joinReport(plan);
    let patched = false;
    for (let i = s.messages.length - 1; i >= 0 && !patched; i--) {
      const m = s.messages[i]!;
      if (m.role !== "user" || typeof m.content === "string") continue;
      m.content = m.content.map((b) => {
        if (b.type !== "tool_result" || b.toolUseId !== plan.toolUseId) return b;
        patched = true;
        const next: ChatToolResultBlock = { type: "tool_result", toolUseId: b.toolUseId, content: report };
        return next;
      });
    }
    // The placeholder is gone (a compacted transcript): hand the report over as text.
    if (!patched) s.messages.push({ role: "user", content: report });
    if (s.toolResults[plan.toolUseId]) s.toolResults[plan.toolUseId] = { type: "tool_result", toolUseId: plan.toolUseId, content: report };
    s.costMicroUsd += plan.tasks.reduce((n, t) => n + (Number.isFinite(t.costMicroUsd) ? Math.max(0, t.costMicroUsd ?? 0) : 0), 0);
    const p = delegationProgress(plan.tasks);
    const call = s.calls.find((c) => c.toolUseId === plan.toolUseId);
    if (call) call.resultSummary = `${progressLine(p)} — ${p.succeeded} succeeded${p.failed ? `, ${p.failed} did not` : ""}`;
    // The merge always keeps its reserved share of time.
    const keep = Math.max(0, opts.maxMs - Math.max(0, plan.reserve.ms));
    if (opts.now - s.startedAt > keep) s.startedAt = opts.now - keep;
    applied.add(plan.planId);
    done.push(plan.planId);
  }
  s.appliedPlans = [...applied];
  return done;
}

/** Is any joined plan still waiting to be merged into this transcript? */
export function hasUnappliedJoin(s: LoopState, plans: readonly DelegationPlanState[]): boolean {
  const applied = new Set(s.appliedPlans ?? []);
  return plans.some((p) => p.joinedAt && !applied.has(p.planId));
}

/** Is a plan's placeholder still in the transcript's last message (the run saved its waiting state)? */
export function placeholderSaved(s: LoopState, plan: Pick<DelegationPlanState, "planId" | "toolUseId">): boolean {
  const last = s.messages[s.messages.length - 1];
  if (last?.role !== "user" || typeof last.content === "string") return false;
  return last.content.some(
    (b) => b.type === "tool_result" && b.toolUseId === plan.toolUseId && typeof b.content === "string" && isWaitingPlaceholder(b.content, plan.planId),
  );
}

export interface DecidedProposal {
  /** The pending call as it was proposed (toolUseId identifies its tool_result). */
  call: ChatToolCall;
  /** What happened: the executed record, or the declined one. */
  exec: ChatToolCall;
  /** The tool_result the model sees for it. */
  result: ChatToolResultBlock;
}

/**
 * Patch a waiting run's saved state with the user's decisions. Returns null
 * when the transcript doesn't hold these tool_results (nothing to resume).
 */
export function patchDecidedProposals(saved: LoopState, decided: readonly DecidedProposal[], now: number): LoopState | null {
  const s: LoopState = structuredClone(saved);
  const byId = new Map(decided.filter((d) => d.call.toolUseId).map((d) => [d.call.toolUseId!, d]));
  if (byId.size === 0) return null;
  let found = 0;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]!;
    if (m.role !== "user" || typeof m.content === "string") continue;
    m.content = m.content.map((b) => {
      if (b.type !== "tool_result" || !byId.has(b.toolUseId)) return b;
      found++;
      return byId.get(b.toolUseId)!.result;
    });
    if (found > 0) break;
  }
  if (found !== byId.size) return null;
  for (const [id, d] of byId) {
    s.toolResults[id] = d.result;
    const idx = s.calls.findIndex((c) => c.toolUseId === id && c.status === "pending_confirmation");
    if (idx >= 0) s.calls[idx] = { ...d.exec, toolUseId: id, runId: d.call.runId };
  }
  delete s.outcome;
  if (typeof s.pausedAt === "number" && s.pausedAt <= now) s.startedAt += now - s.pausedAt;
  delete s.pausedAt;
  return s;
}
