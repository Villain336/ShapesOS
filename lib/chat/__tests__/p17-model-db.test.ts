// ShapesOS — Phase 17 (WS=model) against Postgres, through the REAL chat
// turn (lib/chat/agent.ts) → loop → Anthropic adapter, with a scripted FAKE
// Anthropic Messages API (lib/llm/__tests__/fake-anthropic.ts — MOCK: no
// model is called):
//
//   * A1: the tools + system prefix is byte-identical across two turns of a
//     thread, a new thread and another workspace; the 1-hour TTL sits on the
//     last loaded tool and the system block; the dynamic context is in the
//     first user turn;
//   * A1: every model call is recorded on usage_events with ttft / duration /
//     effort / cache hit / service tier (the observability columns);
//   * A3: the thread's facts summary is stored after a turn with read tools
//     (background workload) and injected — labelled — into the next turn;
//   * A2: a deferred tool found by server-side tool search runs (the fake
//     returns the tool_use the way the API does after expanding a reference).
// Run: DATABASE_URL=… npx tsx --test lib/chat/__tests__/p17-model-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { runTrackedAgentTurn } from "../agent";
import { settleThreadFacts, updateThreadFacts } from "../facts";
import { startFakeAnthropic, allText, loaded, systemText, type AnthropicBody, type FakeAnthropic } from "@/lib/llm/__tests__/fake-anthropic";

const RUN = `p17m-${Date.now().toString(36)}`;
const USER = `${RUN}-user`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
let projA = "";
let projB = "";
let fake: FakeAnthropic;

before(async () => {
  fake = await startFakeAnthropic({ agentWorker: "off" });
  await prisma.workspace.create({ data: { id: WS_A, name: `P17 A ${RUN}`, ownerUserId: USER } });
  await prisma.workspace.create({ data: { id: WS_B, name: `P17 B ${RUN}`, ownerUserId: USER } });
  projA = (await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}-a.example` } })).id;
  projB = (await prisma.project.create({ data: { workspaceId: WS_B, domain: `${RUN}-b.example` } })).id;
  await prisma.keyword.create({ data: { projectId: projA, phrase: "espresso machines", volume: 900, tracked: true } });
});

after(async () => {
  await settleThreadFacts(); // the background facts summaries of the turns above
  await fake.close();
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  await prisma.$disconnect();
});

const turn = (ws: string, projectId: string, threadId: string, text: string) =>
  runTrackedAgentTurn({ projectId, workspaceId: ws, userId: USER, role: "editor", threadId, userContent: text });

const prefix = (b: AnthropicBody) =>
  JSON.stringify({
    tools: (b.tools ?? []).map((t) => ({ ...t, cache_control: undefined })),
    system: (Array.isArray(b.system) ? b.system : []).map((s) => ({ ...s, cache_control: undefined })),
  });

describe("Phase 17 model workstream (fake Anthropic, real chat turn)", () => {
  it("A1: byte-stable cached prefix across turns, threads and workspaces; dynamic context in the first user turn", async () => {
    const t1 = await prisma.aiChatThread.create({ data: { projectId: projA, userId: USER } });
    const t2 = await prisma.aiChatThread.create({ data: { projectId: projB, userId: USER } });
    const bodies: AnthropicBody[] = [];
    fake.script = (b) => {
      if (b.stream) bodies.push(b);
      return { text: "Answer." };
    };
    await turn(WS_A, projA, t1.id, "How are my keywords doing?");
    await turn(WS_A, projA, t1.id, "And my alerts?");
    await turn(WS_B, projB, t2.id, "Hello from another workspace");
    assert.equal(bodies.length, 3);
    assert.equal(prefix(bodies[0]), prefix(bodies[1]), "turn 1 vs turn 2");
    assert.equal(prefix(bodies[0]), prefix(bodies[2]), "workspace A vs workspace B");
    for (const b of bodies) {
      const sys = b.system as Array<Record<string, unknown>>;
      assert.deepEqual(sys.at(-1)!.cache_control, { type: "ephemeral", ttl: "1h" });
      const loadedTools = (b.tools ?? []).filter((t) => t.defer_loading !== true && !t.type);
      assert.deepEqual(loadedTools.at(-1)!.cache_control, { type: "ephemeral", ttl: "1h" });
      assert.doesNotMatch(systemText(b), /espresso machines|PROJECT CONTEXT/);
    }
    const first = bodies[0].messages[0].content as Array<{ type: string; text: string }>;
    assert.match(first[0].text, /^<workspace-context>/);
    assert.match(first[0].text, /espresso machines/);
  });

  it("A1/observability: every model call lands on usage_events with ttft, duration, effort, cache hit and tier", async () => {
    const t = await prisma.aiChatThread.create({ data: { projectId: projA, userId: USER } });
    fake.script = () => ({
      text: "Cached answer.",
      usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, service_tier: "standard" },
    });
    await turn(WS_A, projA, t.id, "Quick question");
    const ev = await prisma.usageEvent.findFirst({ where: { workspaceId: WS_A, action: "llm_tokens" }, orderBy: { occurredAt: "desc" } });
    assert.ok(ev, "llm_tokens event recorded");
    assert.equal(ev!.llmModel, "claude-opus-5-5");
    assert.equal(ev!.llmWorkload, "lead");
    assert.equal(ev!.llmCacheHit, true);
    assert.equal(ev!.llmEffort, "medium", "the lead workload's default effort");
    assert.equal(ev!.llmServiceTier, "standard");
    assert.ok(typeof ev!.llmTtftMs === "number" && ev!.llmTtftMs >= 0);
    assert.ok(typeof ev!.llmDurationMs === "number" && ev!.llmDurationMs >= ev!.llmTtftMs!);
  });

  it("A3: the facts summary is stored on the thread and injected, labelled, into the next turn", async () => {
    const t = await prisma.aiChatThread.create({ data: { projectId: projA, userId: USER } });
    const outcome = await updateThreadFacts(
      { workspaceId: WS_A, projectId: projA, threadId: t.id, calls: [{ tool: "get_keywords", args: {}, status: "executed", resultSummary: "1 keyword: espresso machines (vol 900)" }] },
      { generate: async (prompt) => (assert.match(prompt, /espresso machines/), "- 1 saved keyword: \"espresso machines\" (volume 900)") },
    );
    assert.equal(outcome, "updated");
    const row = await prisma.aiChatThread.findUnique({ where: { id: t.id } });
    assert.equal(row!.factsSummary, '- 1 saved keyword: "espresso machines" (volume 900)');
    assert.ok(row!.factsSummaryAt);
    let body: AnthropicBody | null = null;
    fake.script = (b) => {
      if (b.stream) body = b;
      return { text: "ok" };
    };
    await turn(WS_A, projA, t.id, "Remind me what we found");
    const text = allText(body!);
    assert.match(text, /FACTS GATHERED EARLIER IN THIS CONVERSATION \(a summary of past tool results — a summary, not the record/);
    assert.match(text, /espresso machines" \(volume 900\)/);
    assert.doesNotMatch(systemText(body!), /FACTS GATHERED/, "never in the cached prefix");
    // Mock output is never stored: no live provider → skipped.
    assert.equal(await updateThreadFacts({ workspaceId: WS_A, projectId: projA, threadId: t.id, calls: [{ tool: "get_keywords", args: {}, status: "executed" }] }, { generate: null }), "skipped");
  });

  it("A2: deferred tools are in the request with defer_loading + tool search, and a found one runs", async () => {
    const t = await prisma.aiChatThread.create({ data: { projectId: projA, userId: USER } });
    let step = 0;
    let firstBody: AnthropicBody | null = null;
    fake.script = (b) => {
      if (!b.stream) return { text: "ok" };
      step++;
      if (step === 1) {
        firstBody = b;
        // As the API answers after expanding a tool_reference: a plain tool_use.
        return { calls: [{ name: "ops_list_invoices", input: {} }] };
      }
      return { text: "There are no invoices yet." };
    };
    const out = await turn(WS_A, projA, t.id, "List my invoices");
    const fb = firstBody as AnthropicBody | null;
    assert.ok(fb);
    const inv = (fb!.tools ?? []).find((x) => x.name === "ops_list_invoices");
    assert.equal(inv?.defer_loading, true, "deferred, still sent");
    assert.ok(!loaded(fb!).includes("ops_list_invoices"));
    assert.ok((fb!.tools ?? []).some((x) => x.type === "tool_search_tool_bm25_20251119"));
    const c = out.toolCalls.find((x) => x.tool === "ops_list_invoices");
    assert.equal(c?.status, "executed", c?.resultSummary);
  });
});
