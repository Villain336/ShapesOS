// ShapesOS — Phase 22 (chat): inline decisions on held tool calls, end to end
// against Postgres (the least-privilege app role) and the real agent loop.
//
//   1. Approve from the block: the decision turn runs the held call and the
//      SAME stream continues from the transcript that proposed it — the
//      TOOL_CALL_RESULT carries the call's tool_use id (so the client fills
//      the block in place), the model gets the real result, the text follows,
//      and the persisted thread renders one block per call.
//   2. Deny: nothing runs; the model is told it was denied and carries on.
//   3. Edit: the edited arguments run, marked edited.
//   4. Tier 3 (money): a typed "yes" is refused — the proposal stays pending
//      and nothing runs; a click (a decision) runs it.
//
// The model is a MOCK (lib/chat/__tests__/fake-responses.ts: a scripted fake
// of the OpenAI Responses API); research_keywords uses the labelled
// MockSeoProvider (ALLOW_FAKE_PROVIDERS=1). Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/chat/__tests__/p22-decisions-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { settleBackgroundWork } from "@/lib/runtime/shutdown";
import { runTrackedAgentTurn, type ChatToolCall } from "../agent";
import { streamChatTurnAgui } from "@/lib/agents/agui/adapter";
import { EventType, assertAguiSequence, type AguiEvent } from "@/lib/agents/agui/events";
import { blocksFromThread, type ChatBlock, type ThreadMessageRow } from "../blocks";
import { startFakeModel, toolOutputs, type FakeModel } from "./fake-responses";

const RUN = `p22d-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const USER = `${RUN}-user`;
let projectId = "";
let model: FakeModel;
const savedFake = process.env.ALLOW_FAKE_PROVIDERS;

before(async () => {
  model = await startFakeModel({ agentWorker: "off" });
  process.env.ALLOW_FAKE_PROVIDERS = "1";
  await prisma.workspace.create({ data: { id: WS, name: `P22 ${WS}`, ownerUserId: USER } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: USER, email: `${RUN}@example.com`, name: "P22", role: "owner" } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
});

after(async () => {
  await model.close();
  if (savedFake === undefined) delete process.env.ALLOW_FAKE_PROVIDERS;
  else process.env.ALLOW_FAKE_PROVIDERS = savedFake;
  await settleBackgroundWork();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

async function thread() {
  return prisma.aiChatThread.create({ data: { projectId, userId: USER, title: "New chat", agentKey: "lead" } });
}

function turn(threadId: string, userContent: string) {
  return runTrackedAgentTurn({ projectId, workspaceId: WS, userId: USER, role: "owner", threadId, userContent });
}

async function decide(threadId: string, decisions: Array<{ toolUseId?: string | null; tool: string; decision: "approve" | "deny"; args?: Record<string, unknown> }>): Promise<AguiEvent[]> {
  const events: AguiEvent[] = [];
  for await (const e of streamChatTurnAgui(
    { projectId, workspaceId: WS, userId: USER, role: "owner", threadId, userContent: decisions.map((d) => `${d.decision} ${d.tool}`).join(" · "), decisions },
    { loadSharedState: async () => ({}) as never, pollMs: 20 },
  )) {
    events.push(e);
  }
  return events;
}

async function persistedBlocks(threadId: string): Promise<ChatBlock[]> {
  const rows = await prisma.aiChatMessage.findMany({ where: { threadId }, orderBy: { createdAt: "asc" } });
  return blocksFromThread(
    rows.map((r) => ({ id: r.id, role: r.role, content: r.content, toolCalls: (r.toolCalls as unknown as ThreadMessageRow["toolCalls"]) ?? null, createdAt: r.createdAt.toISOString() })),
  );
}

function pendingOf(calls: ChatToolCall[], tool: string): ChatToolCall {
  const c = calls.find((x) => x.tool === tool && x.status === "pending_confirmation");
  assert.ok(c, `expected a pending ${tool}`);
  return c!;
}

function meta(e: AguiEvent): Record<string, unknown> {
  return ((e as { metadata?: { marketr?: Record<string, unknown> } }).metadata?.marketr ?? {}) as Record<string, unknown>;
}

describe("Phase 22: decisions from the approval block (fake Responses API, real loop, Postgres)", () => {
  it("approve: the held call runs and the SAME stream continues with its result in place", async () => {
    const t = await thread();
    model.script = (b) => {
      const outs = toolOutputs(b);
      if (outs.length === 0) return { calls: [{ tool: "research_keywords", args: { seed: "espresso grinder", limit: "4" } }] };
      return outs.some((o) => /waiting for the user's OK/.test(o)) ? { text: "should not happen" } : { text: "Continued after your OK." };
    };
    const proposed = await turn(t.id, "Research keyword ideas for espresso grinders");
    assert.equal(proposed.awaitingConfirmation, true);
    const held = pendingOf(proposed.toolCalls, "research_keywords");
    assert.ok(held.toolUseId && held.runId, "the proposal remembers its transcript");
    assert.equal(held.toolKind, "spend");
    assert.notEqual(held.tier, 3);

    const before = model.requests.length;
    const events = await decide(t.id, [{ toolUseId: held.toolUseId, tool: "research_keywords", decision: "approve" }]);
    assertAguiSequence(events);
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT && meta(e).toolUseId === held.toolUseId);
    assert.ok(result, "a TOOL_CALL_RESULT keyed by the held call's tool_use id");
    assert.equal(meta(result!).status, "executed");
    assert.equal(meta(result!).confirmed, true);
    assert.equal(meta(result!).ui, "records");
    assert.ok(Array.isArray((meta(result!).payload as { rows?: unknown[] }).rows), "a structured payload rides on the result");
    const text = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as { delta: string }).delta)
      .join("");
    assert.match(text, /Continued after your OK\./, "the turn carries on in the same stream");
    assert.equal(events.at(-1)!.type, EventType.RUN_FINISHED);
    // The model got the REAL result in the transcript that proposed the call.
    const cont = model.requests.slice(before).at(-1)!.body;
    assert.ok(toolOutputs(cont).some((o) => /keyword ideas for "espresso grinder"/.test(o)));

    const blocks = await persistedBlocks(t.id);
    const tools = blocks.filter((b) => b.kind === "tool" && b.tool === "research_keywords");
    assert.equal(tools.length, 1, "one block per call after a reload (no duplicate chip)");
    assert.equal((tools[0] as Extract<ChatBlock, { kind: "tool" }>).status, "executed");
    const approval = blocks.find((b) => b.kind === "approval") as Extract<ChatBlock, { kind: "approval" }>;
    assert.equal(approval.items[0]!.decision, "approved");
    assert.ok(blocks.some((b) => b.kind === "notice" && b.tone === "decision"), "the decision is a notice, not a bubble");
  });

  it("deny: nothing runs; the model is told and carries on", async () => {
    const t = await thread();
    model.script = (b) => {
      const outs = toolOutputs(b);
      if (outs.length === 0) return { calls: [{ tool: "research_keywords", args: { seed: "pour over" } }] };
      return { text: outs.some((o) => /denied/i.test(o)) ? "Okay, skipped." : "unexpected" };
    };
    const proposed = await turn(t.id, "Research keyword ideas for pour over");
    const held = pendingOf(proposed.toolCalls, "research_keywords");
    const serpBefore = await prisma.aiChatMessage.count({ where: { threadId: t.id, role: "tool" } });
    const events = await decide(t.id, [{ toolUseId: held.toolUseId, tool: "research_keywords", decision: "deny" }]);
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT && meta(e).toolUseId === held.toolUseId);
    assert.equal(result && meta(result).status, "cancelled");
    const text = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => (e as { delta: string }).delta).join("");
    assert.match(text, /Okay, skipped\./);
    assert.equal(await prisma.aiChatMessage.count({ where: { threadId: t.id, role: "tool" } }), serpBefore, "no tool row: it never ran");
    const approval = (await persistedBlocks(t.id)).find((b) => b.kind === "approval") as Extract<ChatBlock, { kind: "approval" }>;
    assert.equal(approval.items[0]!.decision, "denied");
  });

  it("edit: the edited arguments run, marked edited", async () => {
    const t = await thread();
    model.script = (b) => (toolOutputs(b).length === 0 ? { calls: [{ tool: "research_keywords", args: { seed: "kettle" } }] } : { text: "Edited run done." });
    const proposed = await turn(t.id, "Research keyword ideas for kettles");
    const held = pendingOf(proposed.toolCalls, "research_keywords");
    await decide(t.id, [{ toolUseId: held.toolUseId, tool: "research_keywords", decision: "approve", args: { seed: "gooseneck kettle", limit: "3" } }]);
    const rows = await prisma.aiChatMessage.findMany({ where: { threadId: t.id, role: "tool" } });
    const ran = rows.flatMap((r) => (r.toolCalls as unknown as ChatToolCall[]) ?? []).find((c) => c.tool === "research_keywords");
    assert.deepEqual(ran?.args, { seed: "gooseneck kettle", limit: "3" });
    assert.equal(ran?.edited, true);
    assert.match(ran?.resultSummary ?? "", /gooseneck kettle/);
  });

  it("Tier 3: a typed yes is refused (nothing runs, it stays pending); a click decides it", async () => {
    const t = await thread();
    model.script = (b) => (toolOutputs(b).length === 0 ? { calls: [{ tool: "ops_record_payment", args: { invoiceId: "inv-missing", amountCents: "1000" } }] } : { text: "Recorded." });
    const proposed = await turn(t.id, "Record the 10 dollar payment on the invoice");
    const held = pendingOf(proposed.toolCalls, "ops_record_payment");
    assert.equal(held.tier, 3, "money-moving: Tier 3");

    const yes = await turn(t.id, "yes");
    assert.match(yes.assistantText, /needs a click/);
    assert.equal(yes.awaitingConfirmation, true);
    assert.ok(yes.toolCalls.some((c) => c.tool === "ops_record_payment" && c.status === "pending_confirmation"), "still pending");
    assert.equal(await prisma.aiChatMessage.count({ where: { threadId: t.id, role: "tool" } }), 0, "a typed yes ran nothing");

    const events = await decide(t.id, [{ toolUseId: held.toolUseId, tool: "ops_record_payment", decision: "approve" }]);
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT && meta(e).toolUseId === held.toolUseId);
    assert.ok(result, "the click ran it through the gate");
    assert.notEqual(meta(result!).status, "pending_confirmation");
    assert.equal(meta(result!).confirmed === true || meta(result!).status === "error", true);
  });
});
