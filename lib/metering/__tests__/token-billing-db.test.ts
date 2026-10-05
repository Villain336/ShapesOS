// ShapesOS Phase 15.2 — model tokens are billed, BYOK is free, retries are
// never charged twice, a capped workspace is refused BEFORE the call, and an
// agency's client workspaces share ONE pool (capped and alerted as one).
//
// DB suite (scripts/test/db-tests.txt) — runs as the least-privilege app role:
//   DATABASE_URL=$APP MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/metering/__tests__/token-billing-db.test.ts
// Model calls go to a STUBBED Anthropic SDK client and a FAKE OpenAI fetch
// (labelled mocks — no network); the adapters, the spend gate, meter() and
// the ledger are real. Live provider calls are UNVERIFIED-LIVE.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AnthropicLlmProvider, type AnthropicClientLike } from "@/lib/llm/anthropic";
import { OpenAiCompatibleLlmProvider } from "@/lib/llm/openai";
import { LlmProviderError } from "@/lib/llm/errors";
import { WorkspaceBoundLlmProvider, valueActionMeterFields } from "@/lib/llm/workspace";
import { llmTokenCredits } from "@/lib/metering/credits";
import { checkCap, getUsageSummary, meter, setSpendCap } from "@/lib/metering/service";
import { joinCreditPool, leaveCreditPool } from "@/lib/metering/pool";

const RUN = randomUUID().slice(0, 8);
const ids = {
  starter: `p15tb-s-${RUN}`,
  byok: `p15tb-b-${RUN}`,
  capped: `p15tb-c-${RUN}`,
  agency: `p15tb-ag-${RUN}`,
  client1: `p15tb-c1-${RUN}`,
  client2: `p15tb-c2-${RUN}`,
  stranger: `p15tb-x-${RUN}`,
};
const OWNER = `p15tb-owner-${RUN}`;

let sent = 0;
function msg(id: string, model: string): Anthropic.Messages.Message {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "ok", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    // Opus 5.5: 1000×4 + 200×20 + 5000×0.2 + 400×5 = 11,000 micro-USD.
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 400 },
  } as unknown as Anthropic.Messages.Message;
}
/** MOCK Anthropic SDK client: counts every request that would leave the box. */
function client(id: string): AnthropicClientLike {
  return {
    messages: {
      create: async (p) => {
        sent++;
        return msg(id, p.model);
      },
      stream: () => {
        throw new Error("not used");
      },
    },
  };
}

const OPUS_CALL_CREDITS = llmTokenCredits(11_000); // ceil(1.65) = 2

async function ws(id: string, plan: Plan, owner = OWNER) {
  await prisma.workspace.create({ data: { id, name: id, ownerUserId: owner, plan } });
}

before(async () => {
  await ws(ids.starter, "starter");
  await ws(ids.byok, "starter");
  await ws(ids.capped, "starter");
  await ws(ids.agency, "agency");
  await ws(ids.client1, "starter");
  await ws(ids.client2, "starter");
  await ws(ids.stranger, "starter", `someone-else-${RUN}`);
  for (const id of [ids.agency, ids.client1, ids.client2, ids.stranger]) {
    await prisma.workspaceMember.create({ data: { workspaceId: id, userId: OWNER, role: id === ids.stranger ? "viewer" : "owner" } });
  }
});

after(async () => {
  await prisma.$disconnect();
});

const used = async (id: string) => (await prisma.creditBalance.findUnique({ where: { workspaceId: id } }))?.usedCredits ?? 0;

describe("model token billing (Phase 15.2)", () => {
  it("a platform-key call is debited ceil(cost × 1.5) credits through meter()", async () => {
    const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_tb_${RUN}_1`) });
    await p.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 64, usage: { workspaceId: ids.starter } });
    const ev = await prisma.usageEvent.findUniqueOrThrow({ where: { idempotencyKey: `llm:anthropic:msg_tb_${RUN}_1` } });
    assert.equal(ev.credits, OPUS_CALL_CREDITS);
    assert.equal(OPUS_CALL_CREDITS, 2);
    assert.equal(ev.keySource, "platform");
    assert.equal(ev.waivedCredits, 0);
    assert.equal(await used(ids.starter), OPUS_CALL_CREDITS);
  });

  it("a BYOK call (the workspace's own key) is recorded at 0 credits with keySource workspace and the credits it saved", async () => {
    const p = new AnthropicLlmProvider("ws-own-key", "claude-opus-5-5", { client: client(`msg_tb_${RUN}_2`), keySource: "workspace" });
    await p.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 64, usage: { workspaceId: ids.byok } });
    const ev = await prisma.usageEvent.findUniqueOrThrow({ where: { idempotencyKey: `llm:anthropic:msg_tb_${RUN}_2` } });
    assert.equal(ev.credits, 0);
    assert.equal(ev.keySource, "workspace");
    assert.equal(ev.waivedCredits, OPUS_CALL_CREDITS);
    assert.equal(ev.llmCostMicroUsd, BigInt(11_000), "tokens and cost are still recorded");
    assert.equal(await used(ids.byok), 0);
    const sum = await getUsageSummary({ workspaceId: ids.byok });
    assert.equal(sum.byokSavedCredits, OPUS_CALL_CREDITS);
    assert.equal(sum.used, 0);
  });

  it("is idempotent per call: recording the same response again never charges twice", async () => {
    const before = await used(ids.starter);
    const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_tb_${RUN}_3`) });
    // The same provider response id twice (a retried record / a replayed turn).
    await p.chat({ messages: [{ role: "user", content: "a" }], maxTokens: 64, usage: { workspaceId: ids.starter } });
    await p.chat({ messages: [{ role: "user", content: "a" }], maxTokens: 64, usage: { workspaceId: ids.starter } });
    assert.equal(await prisma.usageEvent.count({ where: { idempotencyKey: `llm:anthropic:msg_tb_${RUN}_3` } }), 1);
    assert.equal((await used(ids.starter)) - before, OPUS_CALL_CREDITS);
  });

  it("generate() is metered too (OpenAI chat completions, fake fetch)", async () => {
    // MOCK OpenAI endpoint.
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: `chatcmpl_tb_${RUN}`,
          choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20_000, completion_tokens: 10_000, prompt_tokens_details: { cached_tokens: 10_000 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const p = new OpenAiCompatibleLlmProvider("k", "gpt-5.5", "https://api.openai.com/v1", { fetchImpl: fakeFetch });
    const before = await used(ids.starter);
    const out = await p.generate("hi", { usage: { workspaceId: ids.starter } });
    assert.equal(out, "Hello");
    const ev = await prisma.usageEvent.findUniqueOrThrow({ where: { idempotencyKey: `llm:openai-compatible:chatcmpl_tb_${RUN}` } });
    // gpt-5.5: 10,000×5 + 10,000×30 + 10,000×0.5 = 355,000 micro-USD → ceil(53.25) = 54.
    assert.equal(ev.llmCostMicroUsd, BigInt(355_000));
    assert.deepEqual([ev.llmInputTokens, ev.llmOutputTokens, ev.llmCacheReadTokens], [10_000, 10_000, 10_000]);
    assert.equal(ev.credits, 54);
    assert.equal((await used(ids.starter)) - before, 54);
  });

  it("a capped workspace is refused BEFORE the call: nothing is sent and nothing is charged", async () => {
    await setSpendCap(ids.capped, { capCredits: 0 });
    const before = sent;
    const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_tb_${RUN}_4`) });
    await assert.rejects(
      p.chat({ messages: [{ role: "user", content: "x" }], maxTokens: 64, usage: { workspaceId: ids.capped } }),
      (e: unknown) => e instanceof LlmProviderError && e.kind === "cap_exceeded" && !e.retryable && /Credit cap reached/.test(e.message),
    );
    await assert.rejects(p.generate("x", { usage: { workspaceId: ids.capped } }), (e: unknown) => e instanceof LlmProviderError && e.kind === "cap_exceeded");
    assert.equal(sent, before, "the provider was never asked");
    assert.equal(await prisma.usageEvent.count({ where: { workspaceId: ids.capped } }), 0);
  });

  it("the workspace's own key is never gated by the platform credit cap", async () => {
    const p = new AnthropicLlmProvider("own", "claude-opus-5-5", { client: client(`msg_tb_${RUN}_5`), keySource: "workspace" });
    const res = await p.chat({ messages: [{ role: "user", content: "x" }], maxTokens: 64, usage: { workspaceId: ids.capped } });
    assert.equal(res.stopReason, "end_turn");
    const ev = await prisma.usageEvent.findUniqueOrThrow({ where: { idempotencyKey: `llm:anthropic:msg_tb_${RUN}_5` } });
    assert.equal(ev.credits, 0);
  });

  it("a call that crosses the cap mid-flight is still recorded (the work happened); the next one is refused", async () => {
    await setSpendCap(ids.capped, { capCredits: 1 }); // 1 credit left; the call costs 2
    const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_tb_${RUN}_6`) });
    await p.chat({ messages: [{ role: "user", content: "x" }], maxTokens: 64, usage: { workspaceId: ids.capped } });
    const ev = await prisma.usageEvent.findUniqueOrThrow({ where: { idempotencyKey: `llm:anthropic:msg_tb_${RUN}_6` } });
    assert.equal(ev.credits, OPUS_CALL_CREDITS);
    assert.equal((await checkCap(ids.capped)).allowed, false);
    await assert.rejects(
      new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_tb_${RUN}_7`) }).chat({
        messages: [{ role: "user", content: "y" }],
        maxTokens: 64,
        usage: { workspaceId: ids.capped },
      }),
      (e: unknown) => e instanceof LlmProviderError && e.kind === "cap_exceeded",
    );
  });

  it("a call inside a value-priced action is recorded at 0 (billing included) and a BYOK value action costs 0", async () => {
    const before = await used(ids.starter);
    const inner = new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_tb_${RUN}_8`) });
    const bound = new WorkspaceBoundLlmProvider(inner, { workspaceId: ids.starter, billing: "included" }, "platform");
    await bound.generate("draft");
    const ev = await prisma.usageEvent.findUniqueOrThrow({ where: { idempotencyKey: `llm:anthropic:msg_tb_${RUN}_8` } });
    assert.equal(ev.credits, 0);
    assert.equal(await used(ids.starter), before);
    assert.deepEqual(valueActionMeterFields(15, [{ isLive: true, keySource: "workspace" }]), { credits: 0, keySource: "workspace", waivedCredits: 15 });
    assert.deepEqual(valueActionMeterFields(15, [{ isLive: true, keySource: "platform" }]), { keySource: "platform", waivedCredits: 0 });
  });
});

describe("agency credit pooling (Phase 15.2)", () => {
  it("client workspaces join the agency pool only with an admin of both and an Agency-plan owner", async () => {
    await assert.rejects(joinCreditPool({ poolWorkspaceId: ids.client1, clientWorkspaceId: ids.client2, actorUserId: OWNER }), /Agency plan/);
    await assert.rejects(joinCreditPool({ poolWorkspaceId: ids.agency, clientWorkspaceId: ids.stranger, actorUserId: OWNER }), /admin/);
    await assert.rejects(joinCreditPool({ poolWorkspaceId: ids.agency, clientWorkspaceId: ids.agency, actorUserId: OWNER }), /itself/);
    await joinCreditPool({ poolWorkspaceId: ids.agency, clientWorkspaceId: ids.client1, actorUserId: OWNER });
    await joinCreditPool({ poolWorkspaceId: ids.agency, clientWorkspaceId: ids.client2, actorUserId: OWNER });
    await assert.rejects(joinCreditPool({ poolWorkspaceId: ids.client1, clientWorkspaceId: ids.starter, actorUserId: OWNER }), /Agency plan|pool/);
  });

  it("charges from every client workspace land on ONE pool, attributed per workspace", async () => {
    const r1 = await meter({ workspaceId: ids.client1, action: "keyword_research", idempotencyKey: `pool1-${RUN}` });
    const r2 = await meter({ workspaceId: ids.client2, action: "site_audit", idempotencyKey: `pool2-${RUN}` });
    const r3 = await meter({ workspaceId: ids.agency, action: "rank_check", idempotencyKey: `pool3-${RUN}` });
    assert.ok(r1.ok && r2.ok && r3.ok);
    assert.equal(await used(ids.agency), 40 + 30 + 1, "the agency pool carries all three");
    assert.equal(await used(ids.client1), 0, "a client's own balance is not charged");
    assert.equal(await used(ids.client2), 0);
    const e1 = await prisma.usageEvent.findUniqueOrThrow({ where: { idempotencyKey: `pool1-${RUN}` } });
    assert.equal(e1.workspaceId, ids.client1, "usage stays attributed to the client workspace");

    const owner = await getUsageSummary({ workspaceId: ids.agency });
    assert.equal(owner.pool?.role, "owner");
    assert.equal(owner.used, 71, "the owner's summary reconciles with the pool counter");
    assert.deepEqual(owner.pool?.byWorkspace, { [ids.client1]: 40, [ids.client2]: 30, [ids.agency]: 1 });
    assert.equal(owner.remaining, 30_000 - 71);
    const client = await getUsageSummary({ workspaceId: ids.client1 });
    assert.equal(client.pool?.role, "member");
    assert.equal(client.used, 40);
    assert.equal(client.remaining, 30_000 - 71, "a client sees the pool's remaining credits");
    assert.equal(client.included, 30_000);
    const cap = await checkCap(ids.client2);
    assert.equal(cap.poolWorkspaceId, ids.agency);
    assert.equal(cap.used, 71);
  });

  it("is capped as one: the pool's cap refuses every client once it is spent", async () => {
    await setSpendCap(ids.agency, { capCredits: 100 });
    const ok = await meter({ workspaceId: ids.client1, action: "rank_check", idempotencyKey: `pool4-${RUN}` });
    assert.ok(ok.ok);
    const denied = await meter({ workspaceId: ids.client2, action: "keyword_research", idempotencyKey: `pool5-${RUN}` });
    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.reason, "cap_exceeded");
    assert.equal((await checkCap(ids.client2)).allowed, true, "29 credits still remain for smaller charges");
    // A client workspace cannot move the agency's cap.
    await assert.rejects(setSpendCap(ids.client1, { capCredits: 1_000_000 }), /agency workspace manages/);
    // The model-call gate reads the pool too.
    await setSpendCap(ids.agency, { capCredits: 72 });
    await assert.rejects(
      new AnthropicLlmProvider("k", "claude-opus-5-5", { client: client(`msg_tb_${RUN}_9`) }).chat({
        messages: [{ role: "user", content: "x" }],
        maxTokens: 64,
        usage: { workspaceId: ids.client2 },
      }),
      (e: unknown) => e instanceof LlmProviderError && e.kind === "cap_exceeded",
    );
  });

  it("the 80% alert fires once, on the agency workspace", async () => {
    await setSpendCap(ids.agency, { capCredits: 90, alertAtPct: 80 });
    const r = await meter({ workspaceId: ids.client1, action: "rank_check", idempotencyKey: `pool6-${RUN}` });
    assert.ok(r.ok);
    const cap = await prisma.spendCap.findUniqueOrThrow({ where: { workspaceId: ids.agency } });
    assert.ok(cap.lastAlertAt, "the pool owner's alert armed and fired");
    const clientCap = await prisma.spendCap.findUnique({ where: { workspaceId: ids.client1 } });
    assert.equal(clientCap?.lastAlertAt ?? null, null, "no alert on the client's own (unused) cap");
  });

  it("leaving the pool returns the workspace to its own pool", async () => {
    await leaveCreditPool({ clientWorkspaceId: ids.client2, actorUserId: OWNER });
    const before = await used(ids.client2);
    const r = await meter({ workspaceId: ids.client2, action: "rank_check", idempotencyKey: `pool7-${RUN}` });
    assert.ok(r.ok);
    assert.equal((await used(ids.client2)) - before, 1);
    assert.equal((await checkCap(ids.client2)).poolWorkspaceId, undefined);
  });
});
