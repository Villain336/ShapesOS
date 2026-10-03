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
import { TERMINAL_RUN_STATUSES } from "./types";
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
