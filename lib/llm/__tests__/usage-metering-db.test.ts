// ShapesOS — Phase 7: chat() usage is metered through the EXISTING ledger
// (meter() → usage_events, action "llm_tokens") and, with a runId, appended to
// the AgentRun timeline as a `usage` event the run viewer sums into a cost.
// DB suite (scripts/test/db-tests.txt) — runs as the least-privilege app role:
//   DATABASE_URL=$APP MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/llm/__tests__/usage-metering-db.test.ts
// The model calls are a stubbed SDK client (no network); everything after the
// provider — metering, RLS-scoped run events, the totals — is real.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import { prisma } from "@/lib/prisma";
import { createAgentRun, listAgentRunEvents } from "@/lib/agents/runs/service";
import { runUsageFacts, runUsageTotals } from "@/lib/agents/runs/usage";
import { AnthropicLlmProvider, type AnthropicClientLike } from "../anthropic";
import { MockLlmProvider } from "../mock";

// usage_events is append-only (a trigger refuses DELETE): unique ids per run,
// workspaces are left in place.
const RUN = randomUUID().slice(0, 8);
const WS_A = `p7-usage-a-${RUN}`;
const WS_B = `p7-usage-b-${RUN}`;

function msg(id: string, model: string): Anthropic.Messages.Message {
  return {
    id,
    type: "message",
    role: "assistant",
    model, // the stub serves whatever model was asked for
    content: [{ type: "text", text: "ok", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 400 },
  } as unknown as Anthropic.Messages.Message;
}

function client(id: string): AnthropicClientLike {
  return {
    messages: {
      create: async (p) => msg(id, p.model),
      stream: (p) => {
        const events = [
          { type: "message_start", message: { ...msg(id, p.model), content: [], stop_reason: null, usage: { input_tokens: 300, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } },
          { type: "message_stop" },
        ];
        const body = new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
        return MessageStream.fromReadableStream(
          new ReadableStream({
            start(c) {
              c.enqueue(body);
              c.close();
            },
          }),
        );
      },
    },
  };
}

async function createWorkspace(id: string) {
  await prisma.workspace.create({ data: { id, name: id, ownerUserId: `owner-${id}`, plan: "self_hosted" } });
}

before(async () => {
  await createWorkspace(WS_A);
  await createWorkspace(WS_B);
});

after(async () => {
  await prisma.$disconnect();
});

describe("chat() usage → metering + run cost (DB)", () => {
  it("records an llm_tokens UsageEvent with tokens + cost, and a run `usage` event", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "chat", startedBy: "user-a", agentKey: "lead" });
    const id = `msg_p7_${RUN}_1`;
    const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(id), workload: "lead" });
    const res = await p.chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 128,
      usage: { workspaceId: WS_A, runId: run.id, actorId: "user-a", agentKey: "lead" },
    });
    // 1000×4 + 200×20 + 5000×0.2 + 400×5 = 4000 + 4000 + 1000 + 2000
    assert.equal(res.costMicroUsd, 11_000);

    const ev = await prisma.usageEvent.findUnique({ where: { idempotencyKey: `llm:anthropic:${id}` } });
    assert.ok(ev, "usage event written");
    assert.equal(ev.workspaceId, WS_A);
    assert.equal(ev.action, "llm_tokens");
    assert.equal(ev.credits, 0);
    assert.equal(ev.actorId, "user-a");
    assert.equal(ev.evidenceRef, `agent_run:${run.id}`);
    assert.equal(ev.llmProvider, "anthropic");
    assert.equal(ev.llmModel, "claude-opus-5-5");
    assert.equal(ev.llmWorkload, "lead");
    assert.deepEqual(
      [ev.llmInputTokens, ev.llmOutputTokens, ev.llmCacheReadTokens, ev.llmCacheWriteTokens],
      [1000, 200, 5000, 400],
    );
    assert.equal(ev.llmCostMicroUsd, BigInt(11_000));

    const events = await listAgentRunEvents(WS_A, run.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "usage");
    assert.match(events[0].summary, /Model call on claude-opus-5-5: 6,600 tokens, ≈\$0\.0110/);
    const payload = events[0].payload as Record<string, unknown>;
    assert.equal(payload.usageEventId, ev.id);
    assert.equal(payload.costMicroUsd, 11_000);
  });

  it("chatStream records too, and the run viewer sums the run's cost", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "chat", startedBy: "user-a" });
    const p1 = new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_p7_${RUN}_2`) });
    await p1.chat({ messages: [{ role: "user", content: "a" }], maxTokens: 64, usage: { workspaceId: WS_A, runId: run.id } });
    const p2 = new AnthropicLlmProvider("k", "claude-sonnet-5-5", { client: client(`msg_p7_${RUN}_3`) });
    for await (const _ of p2.chatStream({ messages: [{ role: "user", content: "b" }], maxTokens: 64, usage: { workspaceId: WS_A, runId: run.id } })) void _;

    const streamed = await prisma.usageEvent.findUnique({ where: { idempotencyKey: `llm:anthropic:msg_p7_${RUN}_3` } });
    assert.ok(streamed);
    assert.equal(streamed.llmModel, "claude-sonnet-5-5");
    assert.deepEqual([streamed.llmInputTokens, streamed.llmOutputTokens], [300, 50]);
    // Sonnet 5.5: 300×2 + 50×10 = 1100
    assert.equal(streamed.llmCostMicroUsd, BigInt(1_100));

    const totals = runUsageTotals(await listAgentRunEvents(WS_A, run.id));
    assert.equal(totals.calls, 2);
    assert.equal(totals.costMicroUsd, 11_000 + 1_100);
    assert.equal(totals.unpricedCalls, 0);
    assert.deepEqual(totals.models, ["claude-opus-5-5", "claude-sonnet-5-5"]);
    const facts = Object.fromEntries(runUsageFacts(totals));
    assert.equal(facts["Model cost"], "$0.0121 (estimated)");
  });

  it("an unknown price is recorded as null — never guessed — and the run says so", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "chat", startedBy: "user-a" });
    const p = new AnthropicLlmProvider("k", "claude-opus-4-8", { client: client(`msg_p7_${RUN}_4`) });
    const res = await p.chat({ messages: [{ role: "user", content: "c" }], maxTokens: 64, usage: { workspaceId: WS_A, runId: run.id } });
    assert.equal(res.costMicroUsd, null);
    const ev = await prisma.usageEvent.findUnique({ where: { idempotencyKey: `llm:anthropic:msg_p7_${RUN}_4` } });
    assert.equal(ev?.llmCostMicroUsd, null);
    const facts = Object.fromEntries(runUsageFacts(runUsageTotals(await listAgentRunEvents(WS_A, run.id))));
    assert.match(facts["Model cost"], /Unknown/);
  });

  it("a runId from another workspace never gets the event (RLS), and the call still succeeds", async () => {
    const otherRun = await createAgentRun({ workspaceId: WS_B, kind: "chat", startedBy: "user-b" });
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
    try {
      const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_p7_${RUN}_5`) });
      const res = await p.chat({ messages: [{ role: "user", content: "d" }], maxTokens: 64, usage: { workspaceId: WS_A, runId: otherRun.id } });
      assert.equal(res.stopReason, "end_turn");
    } finally {
      console.warn = warn;
    }
    assert.equal((await listAgentRunEvents(WS_B, otherRun.id)).length, 0);
    assert.ok(warnings.some((w) => /\[llm-usage\] could not record usage/.test(w)));
    // The ledger row is still the caller's own workspace's.
    const ev = await prisma.usageEvent.findUnique({ where: { idempotencyKey: `llm:anthropic:msg_p7_${RUN}_5` } });
    assert.equal(ev?.workspaceId, WS_A);
  });

  it("no usage context, or a mock provider, records nothing", async () => {
    const before = await prisma.usageEvent.count({ where: { workspaceId: WS_B, action: "llm_tokens" } });
    await new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_p7_${RUN}_6`) }).chat({ messages: [{ role: "user", content: "e" }], maxTokens: 64 });
    await new MockLlmProvider().chat({ messages: [{ role: "user", content: "f" }], maxTokens: 64, usage: { workspaceId: WS_B } });
    assert.equal(await prisma.usageEvent.count({ where: { workspaceId: WS_B, action: "llm_tokens" } }), before);
    assert.equal(await prisma.usageEvent.count({ where: { idempotencyKey: `llm:anthropic:msg_p7_${RUN}_6` } }), 0);
  });
});
