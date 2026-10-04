// ShapesOS — Phase 8: what each agent job kind does.
//
//   chat_turn — a chat turn handed off by its request (or queued before its
//               first step): continue the run's transcript to the end
//               (lib/chat/agent.ts continueTrackedAgentTurn).
//   mission   — a mission launch: runMission with each executor step run as a
//               sub-agent loop (lib/agents/mission-runtime.ts).
//
// Handlers are imported lazily so the worker module stays light (and tests
// can pass their own handler table).

import type { ClaimedAgentJob } from "./store";

export interface AgentJobContext {
  /** Aborted when this worker loses the job's lease. */
  signal: AbortSignal;
  workerId: string;
}

export type AgentJobHandler = (job: ClaimedAgentJob, ctx: AgentJobContext) => Promise<unknown>;

export const defaultAgentJobHandlers: Record<string, AgentJobHandler> = {
  async chat_turn(job, ctx) {
    const { continueTrackedAgentTurn } = await import("@/lib/chat/agent");
    const payload = job.payload as import("@/lib/chat/agent").ChatTurnJobPayload;
    if (payload.workspaceId !== job.workspaceId) throw new Error("chat_turn payload belongs to another workspace");
    const out = await continueTrackedAgentTurn(payload, { signal: ctx.signal });
    return { runId: out.runId, cancelled: out.cancelled === true, awaitingConfirmation: out.awaitingConfirmation === true };
  },
  async mission(job, ctx) {
    const { runMissionJob } = await import("@/lib/agents/mission-runtime");
    const payload = job.payload as import("@/lib/agents/mission-runtime").MissionJobPayload;
    if (payload.workspaceId !== job.workspaceId) throw new Error("mission payload belongs to another workspace");
    return runMissionJob(payload, { signal: ctx.signal, runId: job.runId });
  },
};
