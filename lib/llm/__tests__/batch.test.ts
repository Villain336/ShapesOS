// ShapesOS — Phase 17 (A4, WS=model): the Message Batches path, against a
// stubbed SDK batches resource and an in-memory batch store (no network, no
// database; MOCK). The DB + real queue + fake HTTP server version is
// lib/llm/__tests__/batch-db.test.ts.
// Run: env -u DATABASE_URL npx tsx --test lib/llm/__tests__/batch.test.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlmProvider, type AnthropicClientLike, type BatchesLike } from "../anthropic";
import {
  advanceLlmBatch,
  batchProviderOf,
  memoryBatchStore,
  nextPollDelayMs,
  registerBatchPurpose,
  runLlmBatchJob,
  submitLlmBatch,
  type BatchDeps,
  type BatchResults,
} from "../batch";
import { MockLlmProvider } from "../mock";
import { FailoverLlmProvider } from "../failover";
import { WorkspaceBoundLlmProvider } from "../workspace";
import { LlmProviderError } from "../errors";
import { __setChatSpendGate, __setChatUsageRecorder, type ChatUsageRecord } from "../usage";

const delivered: Array<{ workspaceId: string; results: BatchResults; context: unknown }> = [];
let failNextDelivery = false;
registerBatchPurpose("test_purpose", async (input) => {
  if (failNextDelivery) {
    failNextDelivery = false;
    throw new Error("worker died mid-delivery");
  }
  delivered.push({ workspaceId: input.workspaceId, results: input.results, context: input.context });
});

function message(id: string, text: string): Anthropic.Messages.Message {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: "batch" },
  } as unknown as Anthropic.Messages.Message;
}

/** A stubbed batches resource: ends after `endsAfter` retrieves. */
function stubBatches(endsAfter = 2) {
  const calls = { create: 0, retrieve: 0, results: 0 };
  let submitted: Array<{ custom_id: string; params: Record<string, unknown> }> = [];
  const batches: BatchesLike = {
    async create(p) {
      calls.create++;
      submitted = p.requests as unknown as typeof submitted;
      return { id: "msgbatch_test", processing_status: "in_progress" };
    },
    async retrieve() {
      calls.retrieve++;
      return { id: "msgbatch_test", processing_status: calls.retrieve >= endsAfter ? "ended" : "in_progress" };
    },
    async results() {
      calls.results++;
      const lines = submitted.map((r, i) =>
        r.custom_id === "bad"
          ? { custom_id: r.custom_id, result: { type: "errored", error: { type: "invalid_request_error" } } }
          : { custom_id: r.custom_id, result: { type: "succeeded", message: message(`msg_b_${i}`, `answer to ${r.custom_id}`) } },
      );
      return (async function* () {
        // Any order (the docs: key by custom_id, never by position).
        for (const l of lines.reverse()) yield l;
      })();
    },
  };
  const client: AnthropicClientLike = {
    messages: { create: async () => message("x", "x"), stream: () => { throw new Error("no stream"); }, batches },
  };
  return { calls, client, submitted: () => submitted };
}

let records: ChatUsageRecord[] = [];
let restoreRec: () => void = () => undefined;
let restoreGate: () => void = () => undefined;
beforeEach(() => {
  delivered.length = 0;
  records = [];
  restoreRec = __setChatUsageRecorder(async (r) => void records.push(r));
  restoreGate = __setChatSpendGate(async () => ({ allowed: true }));
});
afterEach(() => {
  restoreRec();
  restoreGate();
});

function harness(provider: unknown) {
  const store = memoryBatchStore();
  const enqueued: Array<{ batchId: string; runAfter?: Date }> = [];
  let clock = 1_000_000;
  const deps: BatchDeps = {
    store,
    resolve: async () => provider as never,
    enqueue: async (e) => void enqueued.push({ batchId: e.batchId, runAfter: e.runAfter }),
    now: () => clock,
  };
  return { store, enqueued, deps, tick: (ms: number) => (clock += ms) };
}

const REQS = [
  { customId: "a", prompt: "Summarise A", maxTokens: 512 },
  { customId: "b", prompt: "Summarise B", maxTokens: 512 },
];

describe("Message Batches path", () => {
  it("submit → poll (in progress) → poll (ended) → results → delivered once, metered at the batch tier", async () => {
    const stub = stubBatches(2);
    const provider = new AnthropicLlmProvider("k", "claude-haiku-4-5", { client: stub.client, workload: "background" });
    const h = harness(provider);
    const s = await submitLlmBatch({ workspaceId: "ws1", purpose: "test_purpose", idempotencyKey: "k1", workload: "background", requests: REQS, context: { day: "2026-10-06" } }, h.deps);
    assert.equal(s.created, true);
    assert.equal(h.enqueued.length, 1, "queued once");

    const step1 = await runLlmBatchJob({ workspaceId: "ws1", batchId: s.id }, h.deps);
    assert.deepEqual(step1, { status: "submitted", pollAfterMs: nextPollDelayMs(0) });
    assert.equal(stub.calls.create, 1);
    assert.deepEqual(stub.submitted().map((r) => [r.custom_id, r.params.model, r.params.max_tokens]), [["a", "claude-haiku-4-5", 512], ["b", "claude-haiku-4-5", 512]]);
    assert.equal("service_tier" in stub.submitted()[0].params, false, "a batch is its own tier");
    assert.equal(h.enqueued.length, 2, "the next poll is queued");
    assert.equal(h.enqueued[1].runAfter!.getTime(), 1_000_000 + 60_000);

    const step2 = await runLlmBatchJob({ workspaceId: "ws1", batchId: s.id }, h.deps);
    assert.equal(step2.status, "polling");
    assert.equal(step2.pollAfterMs, 120_000, "backoff doubles");
    assert.equal(delivered.length, 0);

    const step3 = await runLlmBatchJob({ workspaceId: "ws1", batchId: s.id }, h.deps);
    assert.equal(step3.status, "delivered");
    assert.equal(stub.calls.create, 1, "never resubmitted");
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].results, { a: { text: "answer to a" }, b: { text: "answer to b" } });
    assert.deepEqual(delivered[0].context, { day: "2026-10-06" });
    // Usage: one record per result, batch tier → 50% (Haiku: 1000×1 + 200×5 = 2000 → 1000).
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.serviceTier === "batch" && r.costMicroUsd === 1000 && r.workload === "background"));
    assert.deepEqual(records.map((r) => r.responseId).sort(), ["msg_b_0", "msg_b_1"]);
    // Nothing more to do.
    assert.equal((await runLlmBatchJob({ workspaceId: "ws1", batchId: s.id }, h.deps)).status, "noop");
    assert.equal(h.store.rows.get(s.id)!.status, "delivered");
  });

  it("is idempotent per (workspace, key): the same work twice → one row, one queued job, one batch", async () => {
    const stub = stubBatches();
    const h = harness(new AnthropicLlmProvider("k", "claude-haiku-4-5", { client: stub.client }));
    const a = await submitLlmBatch({ workspaceId: "ws1", purpose: "test_purpose", idempotencyKey: "same", workload: "background", requests: REQS }, h.deps);
    const b = await submitLlmBatch({ workspaceId: "ws1", purpose: "test_purpose", idempotencyKey: "same", workload: "background", requests: REQS }, h.deps);
    assert.equal(a.id, b.id);
    assert.equal(b.created, false);
    assert.equal(h.enqueued.length, 1);
    const other = await submitLlmBatch({ workspaceId: "ws2", purpose: "test_purpose", idempotencyKey: "same", workload: "background", requests: REQS }, h.deps);
    assert.notEqual(other.id, a.id, "keys are per workspace");
  });

  it("a worker restart in the middle: a submitted batch is polled (never resubmitted); a delivery that died is retaken once", async () => {
    const stub = stubBatches(1);
    const h = harness(new AnthropicLlmProvider("k", "claude-haiku-4-5", { client: stub.client }));
    const s = await submitLlmBatch({ workspaceId: "ws1", purpose: "test_purpose", idempotencyKey: "restart", workload: "background", requests: REQS }, h.deps);
    await advanceLlmBatch("ws1", s.id, h.deps); // submitted, then the worker "dies"
    failNextDelivery = true;
    await assert.rejects(advanceLlmBatch("ws1", s.id, h.deps), /worker died mid-delivery/);
    assert.equal(h.store.rows.get(s.id)!.status, "delivering");
    // A second worker right away: the claim is fresh — it does not deliver twice.
    assert.equal((await advanceLlmBatch("ws1", s.id, h.deps)).status, "noop");
    assert.equal(delivered.length, 0);
    // After the stale window, the delivery is retaken and runs once.
    h.store.rows.get(s.id)!.updatedAt = new Date(0);
    h.tick(11 * 60_000);
    assert.equal((await advanceLlmBatch("ws1", s.id, h.deps)).status, "delivered");
    assert.equal(delivered.length, 1);
    assert.equal(stub.calls.create, 1);
    assert.equal(stub.calls.results, 1, "results read once (they are saved before delivery)");
  });

  it("errored items come back as errors keyed by custom_id (results in any order)", async () => {
    const stub = stubBatches(1);
    const h = harness(new AnthropicLlmProvider("k", "claude-haiku-4-5", { client: stub.client }));
    const s = await submitLlmBatch({ workspaceId: "ws1", purpose: "test_purpose", idempotencyKey: "err", workload: "background", requests: [...REQS, { customId: "bad", prompt: "x", maxTokens: 10 }] }, h.deps);
    await advanceLlmBatch("ws1", s.id, h.deps);
    await advanceLlmBatch("ws1", s.id, h.deps);
    assert.match(String((delivered[0].results.bad as { error: string }).error), /errored/);
    assert.deepEqual(delivered[0].results.a, { text: "answer to a" });
  });

  it("a provider without a Batch API runs direct (generate(), metered) and still delivers; mock never delivers", async () => {
    const generated: string[] = [];
    const direct = new MockLlmProvider();
    Object.defineProperty(direct, "isLive", { value: true });
    direct.generate = async (prompt, opts) => (generated.push(`${prompt}|${opts?.usage?.workspaceId}`), `direct ${prompt}`);
    const h = harness(direct);
    const s = await submitLlmBatch({ workspaceId: "ws1", purpose: "test_purpose", idempotencyKey: "direct", workload: "background", requests: REQS }, h.deps);
    assert.equal((await advanceLlmBatch("ws1", s.id, h.deps)).status, "delivered");
    assert.deepEqual(generated, ["Summarise A|ws1", "Summarise B|ws1"], "metered through the workspace's usage context");
    assert.deepEqual(delivered[0].results.a, { text: "direct Summarise A" });

    const mock = harness(new MockLlmProvider());
    const m = await submitLlmBatch({ workspaceId: "ws1", purpose: "test_purpose", idempotencyKey: "mock", workload: "background", requests: REQS }, mock.deps);
    assert.equal((await advanceLlmBatch("ws1", m.id, mock.deps)).status, "failed");
    assert.match(mock.store.rows.get(m.id)!.lastError ?? "", /mock output is never delivered/);
    assert.equal(delivered.length, 1);
  });

  it("a capped workspace is refused before anything is sent (failed, not retried)", async () => {
    restoreGate();
    restoreGate = __setChatSpendGate(async () => ({ allowed: false, message: "Credit cap reached" }));
    const stub = stubBatches();
    const h = harness(new AnthropicLlmProvider("k", "claude-haiku-4-5", { client: stub.client }));
    const s = await submitLlmBatch({ workspaceId: "ws1", purpose: "test_purpose", idempotencyKey: "cap", workload: "background", requests: REQS }, h.deps);
    assert.equal((await advanceLlmBatch("ws1", s.id, h.deps)).status, "failed");
    assert.equal(stub.calls.create, 0);
    assert.match(h.store.rows.get(s.id)!.lastError ?? "", /Credit cap reached/);
  });

  it("finds the Anthropic provider under the workspace binding and failover; unknown purposes are refused", async () => {
    const stub = stubBatches();
    const a = new AnthropicLlmProvider("k", "claude-haiku-4-5", { client: stub.client });
    const fo = new FailoverLlmProvider(a, new MockLlmProvider(), { workload: "background", primaryModel: "a", fallbackModel: "b" });
    const bound = new WorkspaceBoundLlmProvider(fo, { workspaceId: "ws" }, "platform");
    assert.equal(batchProviderOf(bound), a);
    assert.equal(batchProviderOf(new MockLlmProvider()), null);
    await assert.rejects(submitLlmBatch({ workspaceId: "w", purpose: "nope", idempotencyKey: "k", workload: "background", requests: REQS }, harness(a).deps), /unknown purpose/);
    assert.ok(new LlmProviderError({ provider: "x", kind: "cap_exceeded", detail: "d" }).retryable === false);
  });
});
