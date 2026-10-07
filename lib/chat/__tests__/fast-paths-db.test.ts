// ShapesOS — Phase 17 (latency, A8): the no-model fast paths through the
// REAL tracked turn, against Postgres (app role) and the scripted fake model
// (lib/chat/__tests__/fake-responses.ts — MOCK; its request counter proves
// which turns called a model).
//   * a slash command issues ZERO model calls in live mode;
//   * a proposing slash command goes through the same tool gate: it asks
//     without a rule, runs under a Tier 0–2 rule, and a Tier 3 action never
//     auto-runs, whatever the rule says;
//   * the answer cache: a standalone repeat is answered without the model and
//     labelled; a data change (the data version in the prompt) or an answer
//     that used tools is never served from it.
// Run: DATABASE_URL=<app role> npx tsx --test lib/chat/__tests__/fast-paths-db.test.ts

import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { settleBackgroundWork } from "@/lib/runtime/shutdown";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { startFakeModel, toolOutputs, type FakeModel } from "./fake-responses";
import { runTrackedAgentTurn, type ChatToolCall } from "../agent";
import { executeTool } from "../tool-exec";
import { registerExtraTool, type ToolDef } from "../tools";
import { answerCache, CACHED_ANSWER_TOOL } from "../answer-cache";
import { toolResultCache } from "../tool-cache";
import { flushUsageRecording } from "@/lib/llm/usage";

const RUN = randomUUID().slice(0, 8);
const WS = `p17fp-${RUN}`;
const USER = `p17fp-user-${RUN}`;
let projectId = "";
let model: FakeModel;

// A Tier-3 action (a refund is money): the description trips TIER3_PATTERNS.
const t_refund: ToolDef = {
  name: "t_p17_refund_payment",
  description: "Refund a customer payment.",
  kind: "spend",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    throw new Error("a Tier 3 action must never run without the person's OK");
  },
};

before(async () => {
  model = await startFakeModel({ agentWorker: "off" });
  registerExtraTool(t_refund);
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
  await prisma.keyword.create({ data: { projectId, phrase: "espresso machines", tracked: true, volume: 1200 } });
});

after(async () => {
  await flushUsageRecording();
  await settleBackgroundWork();
  await model.close();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

beforeEach(() => {
  answerCache.clear();
  toolResultCache.clear();
});

const thread = () => prisma.aiChatThread.create({ data: { projectId, userId: USER, title: "New chat", agentKey: "lead", allowedTools: [] } });
/** As POST /api/agents/chat does: the user turn is saved first, then the turn runs. */
const turn = async (threadId: string, userContent: string) => {
  await prisma.aiChatMessage.create({ data: { threadId, role: "user", content: userContent } });
  return runTrackedAgentTurn({ projectId, workspaceId: WS, userId: USER, role: "editor", threadId, userContent });
};
const by = (calls: ChatToolCall[], tool: string) => calls.find((c) => c.tool === tool);

describe("slash commands: no model, same gate", () => {
  it("/keywords answers from the tool with zero model calls", async () => {
    const t = await thread();
    const before = model.requests.length;
    const out = await turn(t.id, "/keywords");
    assert.equal(model.requests.length - before, 0, "no model call");
    assert.equal(by(out.toolCalls, "get_keywords")?.status, "executed");
    assert.match(out.assistantText, /Keywords/);
    assert.match(out.assistantText, /1 keyword/);
  });

  it("/rankings, /alerts, /competitors and /help: zero model calls", async () => {
    const t = await thread();
    const before = model.requests.length;
    for (const c of ["/rankings", "/alerts", "/competitors", "/help"]) await turn(t.id, c);
    assert.equal(model.requests.length - before, 0);
  });

  it("a proposing command asks without a rule and runs only under a Tier 0–2 rule", async () => {
    const t = await thread();
    const before = model.requests.length;
    const asked = await turn(t.id, "/workflow wf-missing");
    assert.equal(by(asked.toolCalls, "run_workflow")?.status, "pending_confirmation");
    assert.equal(asked.awaitingConfirmation, true);
    await withWorkspaceScope(WS, (tx) => tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "*", action: "run_workflow", behavior: "auto", updatedBy: USER } }));
    const ran = await turn(t.id, "/workflow wf-missing");
    const call = by(ran.toolCalls, "run_workflow")!;
    assert.notEqual(call.status, "pending_confirmation", "a Tier 2 action runs under its rule");
    assert.match(call.autoApproved ?? "", /run_workflow rule/);
    assert.equal(model.requests.length - before, 0);
    await withWorkspaceScope(WS, (tx) => tx.automationSetting.deleteMany({ where: { workspaceId: WS } }));
  });

  it("a Tier 3 action through the same gate still asks, even with a forced auto rule", async () => {
    await withWorkspaceScope(WS, (tx) => tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "*", action: "t_p17_refund_payment", behavior: "auto", updatedBy: USER } }));
    const call: ChatToolCall = { tool: t_refund.name, args: {}, status: "executed" };
    await executeTool({ projectId, workspaceId: WS, userId: USER, role: "owner", confirmed: false, agentKey: "lead", grant: null }, t_refund.name, {}, call);
    assert.equal(call.status, "pending_confirmation");
    assert.equal(call.autoApproved, undefined);
    assert.equal(call.autoAction, undefined, "never offered auto either");
    await withWorkspaceScope(WS, (tx) => tx.automationSetting.deleteMany({ where: { workspaceId: WS } }));
  });
});

describe("answer cache through the real turn", () => {
  it("a standalone repeat is answered without the model and labelled; a data change misses", async () => {
    model.script = () => ({ text: "Your visibility score is 42." });
    const before = model.requests.length;
    const first = await turn((await thread()).id, "What's my visibility score?");
    assert.equal(first.assistantText, "Your visibility score is 42.");
    assert.equal(model.requests.length - before, 1);

    const t2 = await thread();
    const second = await turn(t2.id, "what's my visibility score");
    assert.equal(model.requests.length - before, 1, "the repeat called no model");
    assert.equal(second.cached, true);
    assert.equal(second.assistantText, "Your visibility score is 42.");
    assert.ok(by(second.toolCalls, CACHED_ANSWER_TOOL), "labelled as cached");
    const saved = await prisma.aiChatMessage.findFirst({ where: { threadId: t2.id, role: "assistant" }, orderBy: { createdAt: "desc" } });
    assert.ok((saved!.toolCalls as unknown as ChatToolCall[]).some((c) => c.tool === CACHED_ANSWER_TOOL));

    // The data the answer stood on changed: a new tracked keyword (the
    // project context in the prompt carries it).
    await prisma.keyword.create({ data: { projectId, phrase: "grinders", tracked: true, volume: 300 } });
    const third = await turn((await thread()).id, "What's my visibility score?");
    assert.equal(model.requests.length - before, 2, "a data change misses the cache");
    assert.notEqual(third.cached, true);
  });

  it("an answer that used tools is never cached; a question inside a conversation is never served from it", async () => {
    model.script = (b) => (toolOutputs(b).length ? { text: "You track 2 keywords." } : { calls: [{ tool: "get_keywords" }] });
    const before = model.requests.length;
    await turn((await thread()).id, "How many keywords do I track?");
    await turn((await thread()).id, "How many keywords do I track?");
    assert.equal(model.requests.length - before, 4, "two model calls per turn, both turns");

    model.script = () => ({ text: "Plain answer." });
    const t = await thread();
    await turn(t.id, "Tell me a fact");
    const n = model.requests.length;
    await turn(t.id, "Tell me a fact");
    assert.equal(model.requests.length - n, 1, "the same question in the same thread goes to the model (it may lean on the conversation)");
  });
});
