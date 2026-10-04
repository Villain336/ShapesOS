// ShapesOS — chat() usage → metering (Phase 7).
//
// Every live chat()/chatStream() call that carries a ChatUsageContext is
// recorded through the EXISTING metering service (lib/metering/service.ts
// meter()) as an `llm_tokens` UsageEvent — the same append-only, idempotent
// ledger as every other charge, with the token counts, model and estimated
// vendor cost on the event row. No parallel ledger.
//
// `llm_tokens` is a zero-credit passthrough action today (see credits.ts):
// the row makes token spend visible per workspace and per run; whether hosted
// plans charge credits for it is a pricing decision, not this module's.
//
// With a runId the call also appends a `usage` event to the AgentRun
// timeline (tokens + estimated cost), which the run viewer sums into the
// run's cost.
//
// Recording is best-effort: a metering failure is logged and never fails the
// model call that already happened (and was already paid for). Mock providers
// never record — nothing was spent.

import { randomUUID } from "node:crypto";
import { formatMicroUsd } from "./pricing";
import type { ChatUsage, ChatUsageContext } from "./types";

export interface ChatUsageRecord {
  context: ChatUsageContext;
  workload: string | null;
  provider: string;
  model: string;
  usage: ChatUsage;
  costMicroUsd: number | null;
  /** Provider message / response id — makes the ledger row idempotent. */
  responseId: string | null;
}

export type ChatUsageRecorder = (rec: ChatUsageRecord) => Promise<void>;

/** Payload of an AgentRun `usage` event (read back by lib/agents/runs/usage.ts). */
export interface RunUsagePayload {
  kind: "llm_usage";
  provider: string;
  model: string;
  workload: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when a price is unknown (never guessed). */
  costMicroUsd: number | null;
  usageEventId: string | null;
}

export function usageSummary(rec: Pick<ChatUsageRecord, "model" | "usage" | "costMicroUsd">): string {
  const u = rec.usage;
  const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const cost = rec.costMicroUsd === null ? "cost unknown" : `≈${formatMicroUsd(rec.costMicroUsd)}`;
  return `Model call on ${rec.model}: ${tokens.toLocaleString("en-US")} tokens, ${cost}`;
}

async function recordToMetering(rec: ChatUsageRecord): Promise<void> {
  const ctx = rec.context;
  // Dynamic imports keep the router / adapters free of the DB layer for
  // unit tests and scripts that never record usage.
  const { meter } = await import("@/lib/metering/service");
  const idempotencyKey = `llm:${rec.provider}:${rec.responseId ?? randomUUID()}`;
  const result = await meter({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId ?? null,
    actorId: ctx.actorId ?? null,
    action: "llm_tokens",
    idempotencyKey,
    evidenceRef: ctx.runId ? `agent_run:${ctx.runId}` : null,
    llm: {
      provider: rec.provider,
      model: rec.model,
      workload: rec.workload,
      inputTokens: rec.usage.inputTokens,
      outputTokens: rec.usage.outputTokens,
      cacheReadTokens: rec.usage.cacheReadTokens,
      cacheWriteTokens: rec.usage.cacheWriteTokens,
      costMicroUsd: rec.costMicroUsd,
    },
  });
  if (ctx.runId) {
    const { appendAgentRunEvent } = await import("@/lib/agents/runs/service");
    const payload: RunUsagePayload = {
      kind: "llm_usage",
      provider: rec.provider,
      model: rec.model,
      workload: rec.workload,
      inputTokens: rec.usage.inputTokens,
      outputTokens: rec.usage.outputTokens,
      cacheReadTokens: rec.usage.cacheReadTokens,
      cacheWriteTokens: rec.usage.cacheWriteTokens,
      costMicroUsd: rec.costMicroUsd,
      usageEventId: result.ok ? result.eventId : null,
    };
    await appendAgentRunEvent(ctx.workspaceId, ctx.runId, {
      type: "usage",
      summary: usageSummary(rec),
      payload: payload as unknown as Record<string, unknown>,
    });
  }
}

let recorder: ChatUsageRecorder = recordToMetering;

/** Test seam: capture records instead of writing them. Returns a restore fn. */
export function __setChatUsageRecorder(fn: ChatUsageRecorder | null): () => void {
  const prev = recorder;
  recorder = fn ?? recordToMetering;
  return () => {
    recorder = prev;
  };
}

/** Record one call's usage. Never throws. No context → nothing to record. */
export async function recordChatUsage(rec: Omit<ChatUsageRecord, "context"> & { context?: ChatUsageContext | null }): Promise<void> {
  if (!rec.context?.workspaceId) return;
  try {
    await recorder({ ...rec, context: rec.context });
  } catch (err) {
    console.warn(
      `[llm-usage] could not record usage for model="${rec.model}" (workspace ${rec.context.workspaceId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
