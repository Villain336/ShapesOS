// ShapesOS — Phase 17 (A4, WS=model): the Batch path for work nobody waits for.
//
//   const r = await submitLlmBatch({ workspaceId, purpose: "learning_pass",
//     idempotencyKey: `learning_pass:${date}`, workload: "background",
//     requests: [{ customId: "pass", prompt, maxTokens }], context: {…} });
//
// Anthropic's Message Batches API runs requests asynchronously at 50% of
// standard prices (stacks with prompt caching). The batch is a durable row
// (llm_batch_jobs, FORCE RLS) advanced by the `llm_batch` agent job:
//
//   pending ──submit──▶ submitted ──poll (backoff)──▶ ended ──deliver──▶ delivered
//      │                                                        (purpose handler)
//      └─ provider without a Batch API (OpenAI flex, self-host) ──▶ direct
//         (each prompt through generate(), metered as usual, then delivered)
//
// Guarantees:
//   * idempotent per job: (workspace, idempotencyKey) is unique — submitting
//     the same work twice returns the existing row, never a second batch;
//   * restart-safe: every transition is saved before the next one starts; a
//     worker that dies mid-way leaves the job to the queue's lease reaper and
//     the next claim continues from the saved state (a submitted batch is
//     polled, never resubmitted; results are re-read, and usage recording is
//     idempotent per response id);
//   * delivered once: delivery is claimed with a conditional update
//     (ended → delivering); a claim older than DELIVERY_STALE_MS is retaken
//     (handlers must be idempotent — the learning pass dedupes lessons);
//   * metered: the cap is checked before submit (assertModelSpendAllowed);
//     each result is recorded as llm_tokens at the batch tier (50%);
//   * mock never delivers: no live model → status failed, nothing written.
//
// Known window: a crash between the provider accepting the batch and the
// row saving its id (milliseconds) would submit again on retry — the
// delivery is still single (the row has one id), the duplicate batch is
// paid. Documented, not hidden.

import type { LlmWorkload } from "./router";
import type { ChatUsageContext, LlmProvider } from "./types";
import { AnthropicLlmProvider } from "./anthropic";
import { FailoverLlmProvider } from "./failover";

export interface BatchRequestItem {
  customId: string;
  prompt: string;
  maxTokens: number;
}

export type BatchResults = Record<string, { text: string } | { error: string }>;

export type BatchStatus = "pending" | "submitted" | "ended" | "delivering" | "delivered" | "direct" | "failed";

export interface BatchRow {
  id: string;
  workspaceId: string;
  purpose: string;
  idempotencyKey: string;
  status: BatchStatus;
  workload: string;
  provider: string | null;
  model: string | null;
  providerBatchId: string | null;
  requests: BatchRequestItem[];
  results: BatchResults | null;
  context: Record<string, unknown> | null;
  polls: number;
  lastError: string | null;
  updatedAt: Date;
}

/** Where batch rows live (prisma by default; in memory in unit tests). */
export interface BatchStore {
  /** Create, or return the existing row for (workspaceId, idempotencyKey). */
  upsert(row: Omit<BatchRow, "id" | "status" | "provider" | "model" | "providerBatchId" | "results" | "polls" | "lastError" | "updatedAt">): Promise<{ row: BatchRow; created: boolean }>;
  get(workspaceId: string, id: string): Promise<BatchRow | null>;
  update(workspaceId: string, id: string, patch: Partial<BatchRow> & { submittedAt?: Date; endedAt?: Date; deliveredAt?: Date }): Promise<void>;
  /** Conditional transition; true when this caller won it. */
  transition(workspaceId: string, id: string, from: BatchStatus[], to: BatchStatus, olderThan?: Date): Promise<boolean>;
}

/** A purpose's delivery handler: apply the results (idempotent). */
export type BatchDeliveryHandler = (input: { workspaceId: string; context: Record<string, unknown> | null; results: BatchResults; provider: string | null; model: string | null }) => Promise<void>;

const PURPOSES = new Map<string, BatchDeliveryHandler>();

/** Register what a purpose does with its results (call at module load). */
export function registerBatchPurpose(purpose: string, handler: BatchDeliveryHandler): void {
  PURPOSES.set(purpose, handler);
}

export const BATCH_JOB_KIND = "llm_batch";
/** First poll after submit, then ×2 up to the cap (Batches usually end within the hour; at most 24 h). */
export const BATCH_POLL_FIRST_MS = 60_000;
export const BATCH_POLL_MAX_MS = 15 * 60_000;
/** A delivery claimed longer ago than this is retaken (the deliverer died). */
export const DELIVERY_STALE_MS = 10 * 60_000;

export function nextPollDelayMs(polls: number): number {
  return Math.min(BATCH_POLL_MAX_MS, BATCH_POLL_FIRST_MS * 2 ** Math.max(0, polls));
}

/** The Anthropic provider under a workspace/failover wrapper, when there is one with a Batch API. */
export function batchProviderOf(p: LlmProvider): AnthropicLlmProvider | null {
  let cur: unknown = p;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur instanceof AnthropicLlmProvider) return cur.supportsBatch() ? cur : null;
    if (cur instanceof FailoverLlmProvider) cur = cur.primary;
    else cur = (cur as { inner?: unknown }).inner;
  }
  return null;
}

/** LLM_BATCH=0 turns the Batch path off (everything runs direct, as before Phase 17). */
export function batchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LLM_BATCH ?? "").trim() !== "0";
}

export interface BatchDeps {
  store?: BatchStore;
  /** The workload's provider for the workspace (default: resolveWorkloadForWorkspace). */
  resolve?: (workload: LlmWorkload, workspaceId: string) => Promise<LlmProvider>;
  enqueue?: (input: { workspaceId: string; batchId: string; runAfter?: Date }) => Promise<void>;
  now?: () => number;
}

async function defaultStore(): Promise<BatchStore> {
  return (await import("./batch-store")).prismaBatchStore;
}

async function defaultResolve(workload: LlmWorkload, workspaceId: string): Promise<LlmProvider> {
  const { resolveWorkloadForWorkspace } = await import("./workspace");
  return (await resolveWorkloadForWorkspace(workload, workspaceId)).provider;
}

async function defaultEnqueue(input: { workspaceId: string; batchId: string; runAfter?: Date }): Promise<void> {
  const { enqueueAgentJob } = await import("@/lib/agents/queue/store");
  await enqueueAgentJob({
    workspaceId: input.workspaceId,
    kind: BATCH_JOB_KIND,
    payload: { workspaceId: input.workspaceId, batchId: input.batchId },
    // Polling a day-long batch must not run out of attempts: each poll is its own job.
    maxAttempts: 5,
    ...(input.runAfter ? { runAfter: input.runAfter } : {}),
  });
}

export interface SubmitBatchInput {
  workspaceId: string;
  purpose: string;
  idempotencyKey: string;
  workload: LlmWorkload;
  requests: BatchRequestItem[];
  context?: Record<string, unknown> | null;
}

/**
 * Record the work and queue it. Idempotent: the same (workspace, key)
 * returns the existing row and queues nothing new.
 */
export async function submitLlmBatch(input: SubmitBatchInput, deps: BatchDeps = {}): Promise<{ id: string; status: BatchStatus; created: boolean }> {
  if (!PURPOSES.has(input.purpose)) throw new Error(`llm batch: unknown purpose "${input.purpose}" (registerBatchPurpose first)`);
  if (input.requests.length === 0) throw new Error("llm batch: no requests");
  const ids = new Set(input.requests.map((r) => r.customId));
  if (ids.size !== input.requests.length) throw new Error("llm batch: customIds must be unique");
  const store = deps.store ?? (await defaultStore());
  const { row, created } = await store.upsert({
    workspaceId: input.workspaceId,
    purpose: input.purpose,
    idempotencyKey: input.idempotencyKey,
    workload: input.workload,
    requests: input.requests,
    context: input.context ?? null,
  });
  if (created) await (deps.enqueue ?? defaultEnqueue)({ workspaceId: input.workspaceId, batchId: row.id });
  return { id: row.id, status: row.status, created };
}

export type AdvanceOutcome =
  | { status: "submitted" | "polling"; pollAfterMs: number }
  | { status: "delivered" | "failed" | "noop"; pollAfterMs?: undefined };

function usageFor(row: BatchRow): ChatUsageContext {
  return { workspaceId: row.workspaceId, actorId: null, billing: "tokens" };
}

/**
 * Advance one batch by one or more steps (the `llm_batch` job handler body).
 * Returns when the batch must be polled later (pollAfterMs) or is finished.
 */
export async function advanceLlmBatch(workspaceId: string, batchId: string, deps: BatchDeps = {}): Promise<AdvanceOutcome> {
  const store = deps.store ?? (await defaultStore());
  const now = deps.now ?? Date.now;
  let row = await store.get(workspaceId, batchId);
  if (!row) return { status: "noop" };
  const fail = async (msg: string): Promise<AdvanceOutcome> => {
    await store.update(workspaceId, batchId, { status: "failed", lastError: msg.slice(0, 1000) });
    return { status: "failed" };
  };

  for (let guard = 0; guard < 6; guard++) {
    switch (row.status) {
      case "pending": {
        const provider = await (deps.resolve ?? defaultResolve)(row.workload as LlmWorkload, workspaceId);
        if (!provider.isLive) return fail("no live model for this workload — mock output is never delivered");
        const batcher = batchEnabled() ? batchProviderOf(provider) : null;
        if (!batcher) {
          // Direct: the provider has no Batch API (OpenAI flex / self-host)
          // or batching is off. Each prompt through generate() (metered).
          const results: BatchResults = {};
          for (const r of row.requests) {
            try {
              results[r.customId] = { text: await provider.generate(r.prompt, { maxTokens: r.maxTokens, usage: usageFor(row) }) };
            } catch (err) {
              results[r.customId] = { error: err instanceof Error ? err.message : String(err) };
            }
          }
          await store.update(workspaceId, batchId, { status: "ended", provider: provider.name, results, endedAt: new Date(now()) });
          row = { ...row, status: "ended", provider: provider.name, results };
          continue;
        }
        let submitted: { providerBatchId: string };
        try {
          submitted = await batcher.submitBatch(row.requests, usageFor(row));
        } catch (err) {
          const e = err as { kind?: string; retryable?: boolean; message?: string };
          if (e?.kind === "cap_exceeded" || e?.retryable === false) return fail(`submit: ${e?.message ?? String(err)}`);
          throw err; // retryable: the queue retries this job with backoff
        }
        await store.update(workspaceId, batchId, {
          status: "submitted",
          provider: batcher.name,
          model: batcher.getModel(),
          providerBatchId: submitted.providerBatchId,
          submittedAt: new Date(now()),
        });
        return { status: "submitted", pollAfterMs: nextPollDelayMs(0) };
      }
      case "submitted": {
        const provider = await (deps.resolve ?? defaultResolve)(row.workload as LlmWorkload, workspaceId);
        const batcher = batchProviderOf(provider);
        if (!batcher || !row.providerBatchId) return fail("the batch's provider is no longer configured for this workload");
        const st = await batcher.batchStatus(row.providerBatchId);
        const polls = row.polls + 1;
        if (!st.ended) {
          await store.update(workspaceId, batchId, { polls });
          return { status: "polling", pollAfterMs: nextPollDelayMs(polls) };
        }
        const results = await batcher.batchResults(row.providerBatchId, usageFor(row));
        await store.update(workspaceId, batchId, { status: "ended", polls, results, endedAt: new Date(now()) });
        row = { ...row, status: "ended", polls, results };
        continue;
      }
      case "ended":
      case "delivering": {
        const stale = new Date(now() - DELIVERY_STALE_MS);
        const won = await store.transition(workspaceId, batchId, ["ended", "delivering"], "delivering", stale);
        if (!won) return { status: "noop" }; // someone else is delivering it
        const handler = PURPOSES.get(row.purpose);
        if (!handler) return fail(`no delivery handler for purpose "${row.purpose}"`);
        await handler({ workspaceId, context: row.context, results: row.results ?? {}, provider: row.provider, model: row.model });
        await store.update(workspaceId, batchId, { status: "delivered", deliveredAt: new Date(now()) });
        return { status: "delivered" };
      }
      case "delivered":
      case "direct":
      case "failed":
        return { status: "noop" };
    }
  }
  return { status: "noop" };
}

/** The `llm_batch` agent-job handler: advance, then queue the next poll. */
export async function runLlmBatchJob(payload: { workspaceId: string; batchId: string }, deps: BatchDeps = {}): Promise<AdvanceOutcome> {
  const out = await advanceLlmBatch(payload.workspaceId, payload.batchId, deps);
  if (out.pollAfterMs !== undefined) {
    const now = deps.now ?? Date.now;
    await (deps.enqueue ?? defaultEnqueue)({ workspaceId: payload.workspaceId, batchId: payload.batchId, runAfter: new Date(now() + out.pollAfterMs) });
  }
  return out;
}

/** In-memory store (unit tests). */
export function memoryBatchStore(): BatchStore & { rows: Map<string, BatchRow> } {
  const rows = new Map<string, BatchRow>();
  let seq = 0;
  return {
    rows,
    async upsert(input) {
      for (const r of rows.values()) if (r.workspaceId === input.workspaceId && r.idempotencyKey === input.idempotencyKey) return { row: structuredClone(r), created: false };
      const row: BatchRow = { ...input, id: `batch_${++seq}`, status: "pending", provider: null, model: null, providerBatchId: null, results: null, polls: 0, lastError: null, updatedAt: new Date() };
      rows.set(row.id, row);
      return { row: structuredClone(row), created: true };
    },
    async get(workspaceId, id) {
      const r = rows.get(id);
      return r && r.workspaceId === workspaceId ? structuredClone(r) : null;
    },
    async update(workspaceId, id, patch) {
      const r = rows.get(id);
      if (!r || r.workspaceId !== workspaceId) return;
      const { submittedAt: _s, endedAt: _e, deliveredAt: _d, ...rest } = patch;
      rows.set(id, { ...r, ...rest, updatedAt: new Date() });
    },
    async transition(workspaceId, id, from, to, olderThan) {
      const r = rows.get(id);
      if (!r || r.workspaceId !== workspaceId || !from.includes(r.status)) return false;
      if (r.status === "delivering" && (!olderThan || r.updatedAt > olderThan)) return false;
      rows.set(id, { ...r, status: to, updatedAt: new Date() });
      return true;
    },
  };
}
