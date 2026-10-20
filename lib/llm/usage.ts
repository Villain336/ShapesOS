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
// Phase 17 (latency): recording is ASYNCHRONOUS. The model call's critical
// path (the adapters await record() before they yield `final`) used to carry
// the whole meter() transaction — a FOR UPDATE on the balance row, so
// concurrent calls of one workspace queued behind each other. Now the call
// writes ONE outbox row (an `agent_jobs` row of kind `llm_usage`, no lock),
// starts processing it in the background here (tracked, so a draining
// process waits for it — lib/runtime/shutdown.ts) and returns. If this
// process dies first, the agent worker claims the row when its lease
// passes. Processing = meter() (idempotent per call id: llm:<provider>:
// <response id>) + the run `usage` event (deduplicated per call id), so a
// retry never double-counts and a crash never loses a record. The cap check
// (assertModelSpendAllowed) stays BEFORE the call. Tests await
// flushUsageRecording() before they read the ledger.
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
  /** Phase 17: the ledger key of the call; the event is appended once per key. */
  idempotencyKey?: string;
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

/** The ledger key of one call (a response id is unique per call; a missing one gets a random key). */
export function usageIdempotencyKey(rec: Pick<ChatUsageRecord, "provider" | "responseId">): string {
  return `llm:${rec.provider}:${rec.responseId ?? randomUUID()}`;
}

/** The agent job kind the outbox rows carry (lib/agents/queue/handlers.ts). */
export const LLM_USAGE_JOB_KIND = "llm_usage";

export interface UsageOutboxPayload {
  record: ChatUsageRecord;
  idempotencyKey: string;
}

/** Test seam: called between meter() and the run event (a crash is simulated by throwing). */
let afterMeterHook: ((rec: ChatUsageRecord) => Promise<void> | void) | null = null;
export function __setUsageAfterMeterHook(fn: ((rec: ChatUsageRecord) => Promise<void> | void) | null): void {
  afterMeterHook = fn;
}

/**
 * Process one usage record: the ledger row (idempotent per key) and, with a
 * runId, the run's `usage` event (once per key). Safe to run again after a
 * crash at any point.
 */
export async function processUsageRecord(rec: ChatUsageRecord, idempotencyKey: string = usageIdempotencyKey(rec)): Promise<void> {
  const ctx = rec.context;
  // Dynamic imports keep the router / adapters free of the DB layer for
  // unit tests and scripts that never record usage.
  const { meter } = await import("@/lib/metering/service");
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
  await afterMeterHook?.(rec);
  if (ctx.runId) {
    const { appendAgentRunEvent } = await import("@/lib/agents/runs/service");
    const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
    // Once per call: a retry after a crash between the ledger and the event
    // must not add a second usage event (the run's cost would double).
    const dup = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      tx.agentRunEvent.findFirst({
        where: { workspaceId: ctx.workspaceId, runId: ctx.runId!, type: "usage", payload: { path: ["idempotencyKey"], equals: idempotencyKey } },
        select: { id: true },
      }),
    );
    if (dup) return;
    const payload: RunUsagePayload = {
      kind: "llm_usage",
      idempotencyKey,
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

/** Background processing in flight in this process (flushUsageRecording awaits it). */
const inFlight = new Set<Promise<unknown>>();

/**
 * Phase 17: the default recorder — write the outbox row, then process it in
 * the background (claim by id, meter + run event, complete; a failure
 * re-queues it with backoff for the worker). Only the outbox insert is on
 * the caller's path.
 */
async function recordViaOutbox(rec: ChatUsageRecord): Promise<void> {
  const idempotencyKey = usageIdempotencyKey(rec);
  const { enqueueAgentJob } = await import("@/lib/agents/queue/store");
  const payload: UsageOutboxPayload = { record: rec, idempotencyKey };
  const { id } = await enqueueAgentJob({
    workspaceId: rec.context.workspaceId,
    kind: LLM_USAGE_JOB_KIND,
    // Deliberately NOT linked to the run (runId stays in the payload): a job
    // row's run is what Stop cancels, what the reaper fails and what a
    // shutdown hand-off aborts — none of which may touch a usage record.
    runId: null,
    payload,
  });
  const { trackBackgroundWork } = await import("@/lib/runtime/shutdown");
  const work = trackBackgroundWork(runUsageJobHere(rec.context.workspaceId, id).catch(() => undefined));
  const tracked = work.finally(() => inFlight.delete(tracked));
  inFlight.add(tracked);
  // With no agent worker in this deployment (AGENT_WORKER=off) the small
  // local worker sweeps rows this process could not finish.
  const { kickLocalDelegationWorker } = await import("@/lib/agents/delegation/local-worker");
  kickLocalDelegationWorker();
}

/** Claim the just-written outbox row and process it here (the worker takes it if we lose the claim or die). */
async function runUsageJobHere(workspaceId: string, jobId: string): Promise<void> {
  const { claimAgentJobById, deleteOwnedAgentJob, failAgentJob } = await import("@/lib/agents/queue/store");
  const { agentWorkerConfig } = await import("@/lib/agents/queue/config");
  const workerId = `inline:${process.pid}:${randomUUID().slice(0, 8)}`;
  const job = await claimAgentJobById(workspaceId, jobId, workerId, agentWorkerConfig().leaseMs);
  if (!job) return; // a worker got there first
  const payload = job.payload as UsageOutboxPayload;
  try {
    await processUsageRecord(payload.record, payload.idempotencyKey);
    await deleteOwnedAgentJob(workspaceId, jobId, workerId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[llm-usage] could not record usage for model="${payload.record.model}" (workspace ${workspaceId}): ${message} — re-queued for the agent worker`,
    );
    await failAgentJob(workspaceId, jobId, workerId, message).catch(() => null);
    throw err;
  }
}

/** Wait for every usage record this process is still processing (tests; a drain uses trackBackgroundWork). */
export async function flushUsageRecording(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

let recorder: ChatUsageRecorder = recordViaOutbox;

/** Test seam: capture records instead of writing them. Returns a restore fn. */
export function __setChatUsageRecorder(fn: ChatUsageRecorder | null): () => void {
  const prev = recorder;
  recorder = fn ?? recordViaOutbox;
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
