// ShapesOS — Phase 8: an agent run's saved transcript (resume after a crash).
//
// The agent loop (lib/agents/loop.ts) saves its state — the message list,
// every tool result it already has, step / cost counters — after every model
// call and after every tool call. A worker that picks the run up again
// (lease expired → requeued) loads it and carries on from the last saved
// point; a tool whose result was saved is never run again.
//
// One row per run in agent_run_transcripts (FORCE RLS on app.workspace_id,
// cascades from the run and the workspace). The state is versioned JSON
// owned by the loop; this module only stores it.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export interface TranscriptStore {
  load(workspaceId: string, runId: string): Promise<unknown | null>;
  save(workspaceId: string, runId: string, state: unknown, step: number): Promise<void>;
}

export const prismaTranscriptStore: TranscriptStore = {
  async load(workspaceId, runId) {
    const row = await withWorkspaceScope(workspaceId, (tx) =>
      tx.agentRunTranscript.findFirst({ where: { runId, workspaceId }, select: { state: true } }),
    );
    return row?.state ?? null;
  },
  async save(workspaceId, runId, state, step) {
    const json = state as Prisma.InputJsonValue;
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.agentRunTranscript.upsert({
        where: { runId },
        create: { runId, workspaceId, state: json, step },
        update: { state: json, step },
      }),
    );
  },
};

/** In-memory store for unit tests (and runs without a database row). */
export function memoryTranscriptStore(): TranscriptStore & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async load(workspaceId, runId) {
      const v = rows.get(`${workspaceId}:${runId}`);
      return v === undefined ? null : structuredClone(v);
    },
    async save(workspaceId, runId, state) {
      rows.set(`${workspaceId}:${runId}`, structuredClone(state));
    },
  };
}
