// Marketr — Phase 16 slice 5: agent run persistence.
//
// Server-side DB layer for AgentRun / AgentRunRecording / AgentRunEvent.
// Every read and write goes through withWorkspaceScope() — the tables are
// FORCE RLS fail-closed on the app.workspace_id GUC (see migration
// 20260929120703_phase16_agent_runs), so a caller that forgets the scope
// sees zero rows and cross-workspace writes are rejected WITH CHECK.
// Event seq numbers are assigned atomically (next_seq increment inside the
// same transaction that inserts the event), giving a strict timeline order.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type {
  AgentRunKind,
  AgentRunStatus,
  AgentRunEventType,
  AgentRunLinkage,
  AgentRunEventInput,
} from "./types";
import { LIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "./types";
import { notifyAgentRunFailed } from "@/lib/notifications/producers";
import { emitWebhookEvent } from "@/lib/webhooks/emit";

export interface CreateAgentRunInput extends AgentRunLinkage {
  workspaceId: string;
  kind: AgentRunKind;
  startedBy: string;
  agentState?: Record<string, unknown>;
}

export interface AttachRecordingInput {
  videoPath: string | null;
  tracePath: string;
  stepCount: number;
  sizeBytes: number;
  retentionUntil: Date;
}

/** Create a run in `queued` status; links back to the chat thread/mission. */
export async function createAgentRun(input: CreateAgentRunInput) {
  if (!input.workspaceId) throw new Error("createAgentRun: workspaceId is required");
  if (!input.startedBy) throw new Error("createAgentRun: startedBy is required");
  return withWorkspaceScope(input.workspaceId, (tx) =>
    tx.agentRun.create({
      data: {
        workspaceId: input.workspaceId,
        kind: input.kind,
        startedBy: input.startedBy,
        threadId: input.threadId ?? null,
        missionId: input.missionId ?? null,
        agentKey: input.agentKey ?? null,
        parentRunId: input.parentRunId ?? null,
        allowedTools: input.allowedTools ? [...input.allowedTools] : [],
        agentState: (input.agentState ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    }),
  );
}

/** Mark a run `running` (called when the recorder actually starts). */
export async function markAgentRunRunning(workspaceId: string, runId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.update({
      where: { id: runId, workspaceId },
      data: { status: "running" },
    }),
  );
}

/**
 * Append one timeline event, assigning the next monotonic seq atomically.
 * Throws (P2025) when the run does not exist in this workspace's scope —
 * cross-workspace event injection is rejected by RLS.
 */
export async function appendAgentRunEvent(
  workspaceId: string,
  runId: string,
  event: AgentRunEventInput,
) {
  if (!event.summary?.trim()) throw new Error("appendAgentRunEvent: summary is required");
  return withWorkspaceScope(workspaceId, async (tx) => {
    // Same outer transaction (withWorkspaceScope's) — no nested
    // $transaction: the seq increment and the event insert are atomic.
    const run = await tx.agentRun.update({
      where: { id: runId, workspaceId },
      data: { nextSeq: { increment: 1 } },
      select: { nextSeq: true },
    });
    return tx.agentRunEvent.create({
      data: {
        workspaceId,
        runId,
        seq: run.nextSeq - 1,
        type: event.type,
        summary: event.summary,
        payload: (event.payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  });
}

/** Convenience: append an `agui` protocol event to the timeline. */
export function appendAguiEvent(
  workspaceId: string,
  runId: string,
  summary: string,
  payload?: Record<string, unknown>,
) {
  return appendAgentRunEvent(workspaceId, runId, { type: "agui", summary, payload });
}

/** Attach (upsert) the recording artifacts for a run. */
export async function attachAgentRunRecording(
  workspaceId: string,
  runId: string,
  input: AttachRecordingInput,
) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunRecording.upsert({
      where: { runId, workspaceId },
      create: {
        workspaceId,
        runId,
        videoPath: input.videoPath,
        tracePath: input.tracePath,
        stepCount: input.stepCount,
        sizeBytes: input.sizeBytes,
        retentionUntil: input.retentionUntil,
      },
      update: {
        videoPath: input.videoPath,
        tracePath: input.tracePath,
        stepCount: input.stepCount,
        sizeBytes: input.sizeBytes,
        retentionUntil: input.retentionUntil,
      },
    }),
  );
}

/** Finish a run with a terminal status (sets endedAt). */
export async function finishAgentRun(workspaceId: string, runId: string, status: AgentRunStatus) {
  if (!TERMINAL_RUN_STATUSES.has(status)) {
    throw new Error(`finishAgentRun: ${status} is not a terminal status`);
  }
  const run = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.update({
      where: { id: runId, workspaceId },
      data: { status, endedAt: new Date() },
    }),
  );
  // Phase 4a: agent_run.finished / agent_run.failed webhook (never throws).
  await emitWebhookEvent({
    workspaceId,
    type: status === "failed" ? "agent_run.failed" : "agent_run.finished",
    data: {
      id: run.id,
      kind: run.kind ?? null,
      status: String(run.status),
      startedBy: run.startedBy ?? null,
      endedAt: run.endedAt?.toISOString() ?? null,
    },
    dedupKey: `agent_run:${run.id}`,
  });
  // Phase 8: the run's code sandbox goes with it (never throws).
  await releaseSandboxesQuietly(workspaceId, [runId], `run ${status}`);
  if (status === "failed") {
    // Phase 3 (J): best-effort notification (never throws).
    await notifyAgentRunFailed({
      workspaceId,
      runId: run.id,
      kind: run.kind,
      startedBy: run.startedBy,
    });
  }
  return run;
}

/** Read a run (workspace-scoped; null when outside scope). */
export async function getAgentRun(workspaceId: string, runId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findFirst({
      where: { id: runId, workspaceId },
      include: { recording: true, _count: { select: { events: true } } },
    }),
  );
}

/** Read the run timeline in order (slice 6 viewer consumes this). */
export async function listAgentRunEvents(workspaceId: string, runId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunEvent.findMany({
      where: { runId, workspaceId },
      orderBy: { seq: "asc" },
    }),
  );
}

/**
 * Phase 8: the run's events after a sequence number, in order (bounded) —
 * how the AG-UI SSE route tails a run as it works, in this process or on a
 * worker.
 */
export async function listAgentRunEventsAfter(workspaceId: string, runId: string, afterSeq: number, limit = 500) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunEvent.findMany({
      where: { runId, workspaceId, seq: { gt: afterSeq } },
      orderBy: { seq: "asc" },
      take: Math.min(Math.max(limit, 1), 2000),
      select: { seq: true, type: true, summary: true, payload: true },
    }),
  );
}

/** List runs for a workspace, newest first (bounded). */
export async function listAgentRuns(workspaceId: string, limit = 50) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
      include: { recording: true },
    }),
  );
}

// ---------------------------------------------------------------------------
// Phase 5: a real Stop. Cancellation is cooperative: the request is recorded
// here (and cascades to every run the stopped run handed work to); the agent
// loop checks isAgentRunCancelRequested() before every model call and every
// tool call, and an in-flight model call in this process is aborted through
// lib/agents/runs/abort.ts. The loop then finishes the run as `cancelled`.
// ---------------------------------------------------------------------------

export interface CancelRequestResult {
  /** Runs that were asked to stop (the run itself and its live descendants). */
  runIds: string[];
  /** False when the run had already finished — nothing to stop. */
  stopped: boolean;
}

/**
 * Ask a run (and its sub-agent runs) to stop. Idempotent: asking twice keeps
 * the first request time. Already-finished runs are left alone. Returns the
 * ids that were asked; null when the run is not in this workspace.
 */
export async function requestAgentRunCancel(
  workspaceId: string,
  runId: string,
  userId: string,
): Promise<CancelRequestResult | null> {
  const res = await withWorkspaceScope(workspaceId, async (tx) => {
    const root = await tx.agentRun.findFirst({
      where: { id: runId, workspaceId },
      select: { id: true, status: true },
    });
    if (!root) return null;
    // Walk the sub-agent tree (bounded: delegation is at most two levels deep
    // (Phase 16), the bound keeps a malformed tree from looping).
    const ids = [root.id];
    let frontier = [root.id];
    for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
      const kids = await tx.agentRun.findMany({
        where: { workspaceId, parentRunId: { in: frontier } },
        select: { id: true },
      });
      frontier = kids.map((k) => k.id).filter((id) => !ids.includes(id));
      ids.push(...frontier);
    }
    const now = new Date();
    // Phase 16: a run waiting for the user's OK is live too.
    const live = await tx.agentRun.findMany({
      where: { workspaceId, id: { in: ids }, status: { in: [...LIVE_RUN_STATUSES] } },
      select: { id: true },
    });
    if (live.length === 0) return { runIds: [], stopped: false };
    await tx.agentRun.updateMany({
      where: { workspaceId, id: { in: live.map((r) => r.id) }, cancelRequestedAt: null },
      data: { cancelRequestedAt: now, cancelRequestedBy: userId },
    });
    // A queued run never started: it is cancelled right away.
    await tx.agentRun.updateMany({
      where: { workspaceId, id: { in: live.map((r) => r.id) }, status: "queued" },
      data: { status: "cancelled", endedAt: now },
    });
    return { runIds: live.map((r) => r.id), stopped: true };
  });
  // Phase 8: Stop destroys the stopped runs' code sandboxes right away.
  if (res?.stopped) await releaseSandboxesQuietly(workspaceId, res.runIds, "stopped", true);
  return res;
}

/**
 * Phase 8: destroy the code sandboxes these runs own (lib/sandbox) — on
 * Stop always; at a normal end only when not bound to a chat thread (the
 * thread's next turn reuses it; it ends on its idle timeout). Loaded
 * lazily so the run service doesn't pull the providers in until needed;
 * never throws — a run ends even when its provider is unreachable (the
 * sandbox then idles out on its own).
 */
async function releaseSandboxesQuietly(workspaceId: string, runIds: readonly string[], reason: string, force = false): Promise<void> {
  try {
    const { releaseRunSandbox } = await import("@/lib/sandbox");
    for (const id of runIds) await releaseRunSandbox(workspaceId, id, reason, { force });
  } catch {
    // best effort
  }
}

/** Has anyone asked this run to stop? (cheap; called between steps). */
export async function isAgentRunCancelRequested(workspaceId: string, runId: string): Promise<boolean> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findFirst({
      where: { id: runId, workspaceId },
      select: { cancelRequestedAt: true, status: true },
    }),
  );
  return !!row && (row.cancelRequestedAt !== null || row.status === "cancelled");
}

/** The live (queued/running) runs of a chat thread, newest first. */
export async function listLiveThreadRuns(workspaceId: string, threadId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findMany({
      where: { workspaceId, threadId, status: { in: [...LIVE_RUN_STATUSES] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, agentKey: true, parentRunId: true },
    }),
  );
}
