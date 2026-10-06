// ShapesOS — Phase 8: what each agent job kind does.
//
//   chat_turn — a chat turn handed off by its request (or queued before its
//               first step): continue the run's transcript to the end
//               (lib/chat/agent.ts continueTrackedAgentTurn).
//   mission   — a mission launch: runMission with each executor step run as a
//               sub-agent loop (lib/agents/mission-runtime.ts).
//   pr_feedback — Phase 9 (repos): GitHub feedback on an agent PR continues
//               the run's chat thread on the same branch (lib/ship/continue.ts).
//   slack_mention — Phase 11 (conncore): a Slack @mention / DM runs a turn in
//               the Slack thread's chat thread and replies in Slack.
//   subagent_run — Phase 16 (deleg): one delegated sub-agent (start, or resume
//               after a lease loss / the user's decision on its proposals).
//   delegation_tick — Phase 16: start tasks held back by the caps, or arm a
//               plan whose parent saved its waiting state (safety net).
//   delegation_join — Phase 16: every task of a plan finished — the delegating
//               run carries on (a chat turn, or a sub-agent one level up).
//   llm_usage — Phase 17 (latency): one model call's metering, written as an
//               outbox row by the call and normally processed at once by the
//               process that wrote it; a worker takes the ones left behind
//               (idempotent per call id — lib/llm/usage.ts).
//
// Handlers are imported lazily so the worker module stays light (and tests
// can pass their own handler table).

import type { ClaimedAgentJob } from "./store";

export interface AgentJobContext {
  /** Aborted when this worker loses the job's lease. */
  signal: AbortSignal;
  workerId: string;
  /** Phase 16: this claim is the job's last allowed attempt (no retry after it). */
  lastAttempt?: boolean;
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
  // Phase 9 (repos): continue from PR review feedback (queues a chat_turn).
  async pr_feedback(job) {
    const { continueFromPrFeedback } = await import("@/lib/ship/continue");
    const payload = job.payload as import("@/lib/ship/pull-requests").PrFeedbackJobPayload;
    if (payload.workspaceId !== job.workspaceId) throw new Error("pr_feedback payload belongs to another workspace");
    return continueFromPrFeedback(payload);
  },
  // Phase 11 (conncore): a Slack mention runs a turn in its chat thread and
  // answers in Slack (lib/slack/mention.ts).
  // Phase 16 (deleg): delegated sub-agents and their joins (lib/chat/delegation.ts).
  async subagent_run(job, ctx) {
    const { runDelegatedChild } = await import("@/lib/chat/delegation");
    const payload = job.payload as import("@/lib/agents/delegation/store").SubagentRunJobPayload;
    if (payload.workspaceId !== job.workspaceId) throw new Error("subagent_run payload belongs to another workspace");
    return runDelegatedChild(payload, { signal: ctx.signal, lastAttempt: ctx.lastAttempt });
  },
  async delegation_tick(job) {
    const { pumpDelegation } = await import("@/lib/chat/delegation");
    const payload = job.payload as { workspaceId: string; parentRunId: string; check?: number };
    if (payload.workspaceId !== job.workspaceId) throw new Error("delegation_tick payload belongs to another workspace");
    return pumpDelegation(payload.workspaceId, payload.parentRunId, Number(payload.check) || 0);
  },
  async delegation_join(job, ctx) {
    const { runDelegationJoin } = await import("@/lib/chat/delegation");
    const payload = job.payload as import("@/lib/chat/delegation").DelegationJoinPayload;
    const ws = payload.kind === "chat_turn" ? payload.turn.workspaceId : payload.run.workspaceId;
    if (ws !== job.workspaceId) throw new Error("delegation_join payload belongs to another workspace");
    return runDelegationJoin(payload, { signal: ctx.signal, lastAttempt: ctx.lastAttempt });
  },
  async llm_usage(job) {
    const { processUsageRecord } = await import("@/lib/llm/usage");
    const payload = job.payload as import("@/lib/llm/usage").UsageOutboxPayload;
    if (payload.record?.context?.workspaceId !== job.workspaceId) throw new Error("llm_usage payload belongs to another workspace");
    await processUsageRecord(payload.record, payload.idempotencyKey);
    return { idempotencyKey: payload.idempotencyKey };
  },
  async slack_mention(job) {
    const { runSlackMention } = await import("@/lib/slack/mention");
    const payload = job.payload as import("@/lib/slack/events").SlackMentionJobPayload;
    if (payload.workspaceId !== job.workspaceId) throw new Error("slack_mention payload belongs to another workspace");
    return runSlackMention(payload);
  },
};
