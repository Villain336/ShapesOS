// ShapesOS — chat() usage → metering (Phase 7).
//
// Every live chat()/chatStream() call that carries a ChatUsageContext is
// recorded through the EXISTING metering service (lib/metering/service.ts
// meter()) as an `llm_tokens` UsageEvent — the same append-only, idempotent
// ledger as every other charge, with the token counts, model and estimated
// vendor cost on the event row. No parallel ledger.
//
// Phase 15.2: `llm_tokens` is cost-based. Each call is charged
// ceil(provider cost USD × 100 × 1.5) credits (credits.ts llmTokenCredits),
// on the BILLABLE cost (pricing.ts billableCostMicroUsd — an unknown price is
// charged at the most expensive known rate, never 0). A call on the
// workspace's own key (keySource "workspace") or a local model ("self_host")
// is recorded at 0 credits; the workspace-key row carries the credits it
// saved (waivedCredits). A call inside a value-priced action (context
// billing "included") is recorded at 0 — that action charges the work.
//
// Idempotent per call: the key is llm:<provider>:<response id>, so a record
// that runs twice for the same response charges once (meter() T1).
//
// The cap check runs BEFORE the call (assertModelSpendAllowed, called by
// the adapters): a capped workspace is refused cleanly with a
// non-retryable LlmProviderError("cap_exceeded") and nothing is sent. The
// debit at the end runs with afterTheFact (the call already happened), so
// a call that crosses the cap is still recorded honestly.
//
// With a runId the call also appends a `usage` event to the AgentRun
// timeline (tokens + estimated cost), which the run viewer sums into the
// run's cost.
//
// Recording is best-effort: a metering failure is logged and never fails the
// model call that already happened (and was already paid for). Mock providers
// never record — nothing was spent.

import { randomUUID } from "node:crypto";
import { billableCostMicroUsd, formatMicroUsd } from "./pricing";
import { LlmProviderError } from "./errors";
// credits.ts is pure (no DB): safe to import statically from the adapters' graph.
import { llmTokenCredits as llmTokenCreditsSync } from "@/lib/metering/credits";
import type { ChatTiming, ChatUsage, ChatUsageContext, LlmKeySource } from "./types";

export interface ChatUsageRecord {
  context: ChatUsageContext;
  workload: string | null;
  provider: string;
  model: string;
  usage: ChatUsage;
  costMicroUsd: number | null;
  /** Provider message / response id — makes the ledger row idempotent. */
  responseId: string | null;
  /** Phase 15: whose key served the call. Default "platform". */
  keySource?: LlmKeySource;
  /** Phase 17 (A1): wall-clock of the call (ttftMs null on non-streaming calls). */
  timing?: ChatTiming | null;
  /** Phase 17: the effort sent (null = model default). */
  effort?: string | null;
  /** Phase 17 (A4): the provider-reported service tier ("standard" | "priority" | "batch"). */
  serviceTier?: string | null;
}

/** Phase 17: did the call read anything from the prompt cache? */
export function cacheHit(usage: Pick<ChatUsage, "cacheReadTokens">): boolean {
  return usage.cacheReadTokens > 0;
}

/**
 * Phase 15.2: the credits one call is charged and the credits it saved.
 * Pure — the single source of the token-billing rule.
 */
export function llmCallCharge(
  rec: Pick<ChatUsageRecord, "model" | "usage" | "keySource" | "serviceTier"> & { billing?: ChatUsageContext["billing"] },
): {
  credits: number;
  waivedCredits: number;
  billableCostMicroUsd: number;
  priced: boolean;
} {
  const { costMicroUsd, priced } = billableCostMicroUsd(rec.model, rec.usage, { serviceTier: rec.serviceTier ?? null });
  const list = llmTokenCreditsSync(costMicroUsd);
  const source = rec.keySource ?? "platform";
  if (rec.billing === "included") return { credits: 0, waivedCredits: 0, billableCostMicroUsd: costMicroUsd, priced };
  if (source === "platform") return { credits: list, waivedCredits: 0, billableCostMicroUsd: costMicroUsd, priced };
  return { credits: 0, waivedCredits: source === "workspace" ? list : 0, billableCostMicroUsd: costMicroUsd, priced };
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
  /** Phase 17 (A1): per-call timing and cache outcome. */
  ttftMs?: number | null;
  durationMs?: number | null;
  cacheHit?: boolean;
  effort?: string | null;
  serviceTier?: string | null;
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
  const charge = llmCallCharge({ ...rec, billing: ctx.billing });
  const result = await meter({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId ?? null,
    actorId: ctx.actorId ?? null,
    action: "llm_tokens",
    credits: charge.credits,
    keySource: rec.keySource ?? "platform",
    waivedCredits: charge.waivedCredits,
    // The call already happened (and was paid for): record it even past the
    // cap. The pre-call gate refused capped workspaces.
    afterTheFact: true,
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
      // Phase 17 (A1): per-call observability on the same row.
      ttftMs: rec.timing?.ttftMs ?? null,
      durationMs: rec.timing?.durationMs ?? null,
      effort: rec.effort ?? null,
      cacheHit: cacheHit(rec.usage),
      serviceTier: rec.serviceTier ?? null,
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
      ttftMs: rec.timing?.ttftMs ?? null,
      durationMs: rec.timing?.durationMs ?? null,
      cacheHit: cacheHit(rec.usage),
      effort: rec.effort ?? null,
      serviceTier: rec.serviceTier ?? null,
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

// ── Phase 15.2: the pre-call spend gate ─────────────────────────────────────

export type ChatSpendGate = (ctx: ChatUsageContext) => Promise<{ allowed: true } | { allowed: false; message: string }>;

async function capGate(ctx: ChatUsageContext): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const { checkCap } = await import("@/lib/metering/service");
  const cap = await checkCap(ctx.workspaceId);
  if (cap.allowed) return { allowed: true };
  if (cap.trialExpired) {
    const { trialExpiredMessage } = await import("@/lib/billing/trial");
    return { allowed: false, message: trialExpiredMessage(null) };
  }
  return {
    allowed: false,
    message:
      `Credit cap reached (${cap.used.toLocaleString()} of ${cap.capCredits.toLocaleString()} credits used). ` +
      `Raise the cap or add credits in Settings → Usage, or add your own model key in Settings → Providers.`,
  };
}

let spendGate: ChatSpendGate = capGate;

/** Test seam: replace the cap gate. Returns a restore fn. */
export function __setChatSpendGate(fn: ChatSpendGate | null): () => void {
  const prev = spendGate;
  spendGate = fn ?? capGate;
  return () => {
    spendGate = prev;
  };
}

/**
 * Refuse a platform-key model call for a capped workspace BEFORE it is sent.
 * No context (nothing metered), the workspace's own key, a local model, or
 * a call inside a value-priced action → no gate. A refusal throws a
 * non-retryable LlmProviderError("cap_exceeded"). If the cap cannot be READ
 * (database unavailable) the call proceeds and the warning is logged — the
 * after-the-fact debit still records it; the cap, not an outage, refuses.
 */
export async function assertModelSpendAllowed(
  ctx: ChatUsageContext | null | undefined,
  keySource: LlmKeySource,
  provider: string,
): Promise<void> {
  if (!ctx?.workspaceId || keySource !== "platform" || ctx.billing === "included") return;
  let verdict: Awaited<ReturnType<ChatSpendGate>>;
  try {
    verdict = await spendGate(ctx);
  } catch (err) {
    console.warn(
      `[llm-usage] could not check the credit cap for workspace ${ctx.workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      } — the call proceeds and is recorded after it returns`,
    );
    return;
  }
  if (!verdict.allowed) {
    throw new LlmProviderError({ provider, kind: "cap_exceeded", detail: verdict.message });
  }
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
