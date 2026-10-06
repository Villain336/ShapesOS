// ShapesOS — Phase 18.1 (WS=desk): the Control Center, server side.
//
// One top-bar panel (components/desk/ControlCenter.tsx) over things that
// already exist — nothing here is a second implementation:
//   - Pause all agents → the kill switch (lib/orchestrator/killswitch.ts
//     freezeWorkspace: every executor entry point halts, and createAgentRun
//     refuses new runs) + every live run stopped the way Stop stops it
//     (stopThreadRuns for chat runs; requestAgentRunCancel + abortRun for the
//     rest), audited in command_audit like the kill switch itself. Admin+.
//   - Resume → unfreezeWorkspace (+ audit).
//   - Focus / do not disturb → lib/desktop/focus.server.ts.
//   - Auto-approve → a read-only summary of lib/automation/policy.ts.
//   - Voice → the "voice" preference (lib/desktop/prefs.ts, for 19A).
//   - Spend today → the metering ledger (getUsageSummary from midnight UTC).

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { freezeWorkspace, unfreezeWorkspace } from "@/lib/orchestrator/killswitch";
import { LIVE_RUN_STATUSES } from "@/lib/agents/runs/types";
import { focusView, type FocusView } from "./focus.server";
import { getUserPreferences } from "./prefs";
import { deskRoleAtLeast } from "./widgets";

export const PAUSE_REASON = "Paused from Control Center";

export interface PauseResult {
  paused: true;
  /** Every run asked to stop (roots and their sub-agents). */
  stopped: string[];
}

/** The live runs to stop: roots of every live tree (sub-agents stop with their root). */
async function liveRootRuns(workspaceId: string) {
  const live = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findMany({
      where: { workspaceId, status: { in: [...LIVE_RUN_STATUSES] } },
      select: { id: true, threadId: true, parentRunId: true },
      orderBy: { createdAt: "asc" },
      take: 500,
    }),
  );
  const liveIds = new Set(live.map((r) => r.id));
  return live.filter((r) => !r.parentRunId || !liveIds.has(r.parentRunId));
}

/**
 * Pause every agent in the workspace: freeze it (kill switch), then stop each
 * live run. Idempotent — pausing a paused workspace stops whatever is still
 * live and writes nothing twice for the freeze.
 */
export async function pauseAllAgents(workspaceId: string, actorUserId: string): Promise<PauseResult> {
  await freezeWorkspace(workspaceId, actorUserId, PAUSE_REASON);
  const roots = await liveRootRuns(workspaceId);
  const stopped = new Set<string>();
  const { requestAgentRunCancel } = await import("@/lib/agents/runs/service");
  const { abortRun } = await import("@/lib/agents/runs/abort");
  const { cancelAgentJobsForRun } = await import("@/lib/agents/queue/store");
  const { finishAgentRun } = await import("@/lib/agents/runs/service");
  const { finishIdleStoppedRuns } = await import("@/lib/chat/delegation");
  for (const run of roots) {
    try {
      if (run.threadId) {
        // Exactly what the chat's Stop does (proposals dropped, approvals expired).
        const { stopThreadRuns } = await import("@/lib/chat/agent");
        for (const id of await stopThreadRuns({ workspaceId, threadId: run.threadId, userId: actorUserId, runId: run.id })) stopped.add(id);
        continue;
      }
      // What POST /api/agent-runs/[runId]/cancel does for a non-chat run.
      const res = await requestAgentRunCancel(workspaceId, run.id, actorUserId);
      const ids = res?.runIds ?? [];
      for (const id of ids) {
        stopped.add(id);
        abortRun(id, PAUSE_REASON);
        // A queued hand-off never starts; its run ends here.
        const n = await cancelAgentJobsForRun(workspaceId, id).catch(() => 0);
        if (n > 0) await finishAgentRun(workspaceId, id, "cancelled").catch(() => undefined);
      }
      if (ids.length) await finishIdleStoppedRuns(workspaceId, ids).catch(() => undefined);
    } catch (err) {
      console.warn(`[control-center] pause: run ${run.id} not stopped:`, err instanceof Error ? err.message : err);
    }
  }
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.commandAudit.create({
      data: {
        workspaceId,
        userId: actorUserId,
        kind: "doAction",
        resultSummary: `pause all agents: workspace frozen, ${stopped.size} run(s) asked to stop`,
      },
    }),
  );
  return { paused: true, stopped: [...stopped] };
}

/** Resume: unfreeze (agents may start again). Stopped runs stay stopped. */
export async function resumeAgents(workspaceId: string, actorUserId: string): Promise<void> {
  await unfreezeWorkspace(workspaceId, actorUserId);
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.commandAudit.create({
      data: { workspaceId, userId: actorUserId, kind: "doAction", resultSummary: "resume agents: workspace unfrozen" },
    }),
  );
}

// ---------------------------------------------------------------------------
// The panel's state
// ---------------------------------------------------------------------------

export interface AutoApproveSummary {
  /** Actions that run on their own. */
  auto: number;
  /** Actions that ask first. */
  ask: number;
  /** Actions that never run (incl. money and irreversible ones — Tier 3, locked). */
  never: number;
  /** Of those, locked to "always ask / never" by the money-safety rules. */
  locked: number;
}

export interface ControlState {
  paused: { at: string } | null;
  /** Live (queued, running, waiting) runs right now. */
  liveRuns: number;
  canPause: boolean;
  focus: FocusView;
  autoApprove: AutoApproveSummary;
  voice: { enabled: boolean };
  spendToday: { credits: number; usd: number };
}

export async function autoApproveSummary(workspaceId: string): Promise<AutoApproveSummary> {
  const { KNOWN_ACTIONS, listAutomationRows, resolveAutomationFromRows } = await import("@/lib/automation/policy");
  const rows = await listAutomationRows(workspaceId).catch(() => []);
  const out: AutoApproveSummary = { auto: 0, ask: 0, never: 0, locked: 0 };
  for (const a of KNOWN_ACTIONS) {
    const r = resolveAutomationFromRows(rows, a.action);
    // Never report "auto" for an action whose auto-run is locked, whatever a row says.
    const behavior = !a.autoAllowed && r.behavior === "auto" ? "ask" : r.behavior;
    out[behavior]++;
    if (!a.autoAllowed) out.locked++;
  }
  return out;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Credits metered today (UTC), from the ledger. 1 credit = $0.01. */
export async function spendToday(workspaceId: string, now: Date = new Date()): Promise<{ credits: number; usd: number }> {
  const { getUsageSummary } = await import("@/lib/metering/service");
  const summary = await getUsageSummary({ workspaceId, periodStart: startOfUtcDay(now) });
  return { credits: summary.used, usd: Math.round(summary.used) / 100 };
}

export async function controlState(workspaceId: string, userId: string, role: string | null | undefined, now: Date = new Date()): Promise<ControlState> {
  const [ws, liveRuns, focus, autoApprove, prefs, spend] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { frozenAt: true } }),
    withWorkspaceScope(workspaceId, (tx) => tx.agentRun.count({ where: { workspaceId, status: { in: [...LIVE_RUN_STATUSES] } } })).catch(() => 0),
    focusView(userId, now),
    autoApproveSummary(workspaceId),
    getUserPreferences(userId),
    spendToday(workspaceId, now).catch(() => ({ credits: 0, usd: 0 })),
  ]);
  return {
    paused: ws?.frozenAt ? { at: ws.frozenAt.toISOString() } : null,
    liveRuns,
    canPause: deskRoleAtLeast(role, "admin"),
    focus,
    autoApprove,
    voice: { enabled: prefs.voice.enabled },
    spendToday: spend,
  };
}
