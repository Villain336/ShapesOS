// ShapesOS — Phase 5: the four agent controls, end to end against Postgres.
//
//   1. Limit a task's tools: the model only sees granted tools, and a tool it
//      names anyway (directly or through a connector alias) is refused.
//   2. Auto-approve: a per-agent rule lets a Tier 0/1 action run without the
//      "yes"; a Tier 2 action still asks even when a rule says auto.
//   3. Stop: a stop mid-flight aborts the model call, the run ends
//      `cancelled`, pending proposals are dropped (a later "yes" runs
//      nothing) and the approvals the run raised are expired.
//   4. Hand a task to one sub-agent: the lead's delegate call runs the
//      sub-agent as a child run whose grant never exceeds its parent's.
//   5. RLS: another workspace can't see or stop the run.
//
// The model is a local OpenAI-compatible fake (the router reads
// OPENAI_BASE_URL at call time), so the REAL agent loop, gates and run
// service run unchanged. Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/chat/__tests__/agent-controls-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { computeGrant } from "@/lib/agents/grants";
import {
  appendAgentRunEvent,
  getAgentRun,
  isAgentRunCancelRequested,
  listLiveThreadRuns,
  requestAgentRunCancel,
} from "@/lib/agents/runs/service";
import { runTrackedAgentTurn, stopThreadRuns, type ChatToolCall } from "../agent";

const RUN = `p5-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
let projectId = "";

// ---------------------------------------------------------------------------
// Fake model
// ---------------------------------------------------------------------------

type Script = (prompt: string) => string | Promise<string>;
let script: Script = () => "ok";
const prompts: string[] = [];
let server: Server;

function toolCalls(calls: Array<{ tool: string; args?: Record<string, unknown> }>): string {
  return JSON.stringify({ tool_calls: calls.map((c) => ({ tool: c.tool, args: c.args ?? {} })) });
}

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_MODEL_BULK", "LLM_MODEL", "LLM_API_KEY", "ANTHROPIC_API_KEY", "LLM_SELF_HOST"];
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const prompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0]!.content;
        prompts.push(prompt);
        const content = await script(prompt);
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      } catch {
        if (!res.destroyed) {
          res.writeHead(500);
          res.end();
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;

  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.create({ data: { id, name: `P5 ${id}`, ownerUserId: USER } });
  }
  const p = await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}.example` } });
  projectId = p.id;
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

async function thread(agentKey: string, tools: string[] = []) {
  const grant = computeGrant({ agentKey: agentKey as "lead", requested: tools });
  return prisma.aiChatThread.create({
    data: { projectId, userId: USER, title: "New chat", agentKey, allowedTools: tools.length ? grant.groups : [] },
  });
}

function turn(threadId: string, userContent: string) {
  return runTrackedAgentTurn({
    projectId,
    workspaceId: WS_A,
    userId: USER,
    role: "editor",
    threadId,
    userContent,
  });
}

function byTool(calls: ChatToolCall[], tool: string): ChatToolCall {
  const c = calls.find((x) => x.tool === tool);
  assert.ok(c, `expected a ${tool} call`);
  return c!;
}

// ---------------------------------------------------------------------------

describe("Phase 5 agent controls (live loop, fake model)", () => {
  it("limits a task's tools: hidden from the model, refused when named anyway", async () => {
    const t = await thread("drafter", ["email"]);
    prompts.length = 0;
    script = (p) =>
      p.includes("TOOL RESULT (get_keywords)")
        ? "Done."
        : toolCalls([
            { tool: "research_question", args: { question: "What do rivals charge?" } },
            { tool: "get_keywords" },
            { tool: "connector.dataforseo.keyword_ideas", args: { seed: "espresso" } },
          ]);
    const out = await turn(t.id, "Draft the renewal email");

    const first = prompts[0]!;
    assert.match(first, /Writer sub-agent/);
    assert.doesNotMatch(first, /- research_question \[/, "an ungranted tool must not be in the catalog");
    assert.match(first, /- get_keywords \[/);

    assert.equal(byTool(out.toolCalls, "research_question").status, "denied");
    assert.equal(byTool(out.toolCalls, "get_keywords").status, "executed");
    const viaAlias = byTool(out.toolCalls, "connector.dataforseo.keyword_ideas");
    assert.equal(viaAlias.status, "denied", "a connector alias can't reach an ungranted group");

    const run = await getAgentRun(WS_A, out.runId);
    assert.equal(run?.status, "succeeded");
    assert.equal(run?.agentKey, "drafter");
    assert.deepEqual(run?.allowedTools, ["workspace", "email"]);
    const events = await withWorkspaceScope(WS_A, (tx) =>
      tx.agentRunEvent.findMany({ where: { workspaceId: WS_A, runId: out.runId }, orderBy: { seq: "asc" } }),
    );
    assert.ok(events.some((e) => e.type === "gate" && /Refused research_question/.test(e.summary)));
  });

  it("auto-approves a Tier 0/1 action under an agent rule; Tier 2 still asks; Stop drops the proposal", async () => {
    await withWorkspaceScope(WS_A, async (tx) => {
      await tx.automationSetting.create({
        data: { workspaceId: WS_A, agentKey: "lead", action: "audit_site", behavior: "auto", updatedBy: USER },
      });
      // An every-agent "auto" on a Tier-2 kind must not widen it.
      await tx.automationSetting.create({
        data: { workspaceId: WS_A, agentKey: "*", action: "run_workflow", behavior: "auto", updatedBy: USER },
      });
    });
    const t = await thread("lead");
    script = () =>
      toolCalls([
        { tool: "run_seo_audit", args: {} },
        { tool: "run_workflow", args: { workflowId: "wf-missing" } },
      ]);
    const out = await turn(t.id, "Audit the site and kick off the weekly workflow");

    const audit = byTool(out.toolCalls, "run_seo_audit");
    assert.notEqual(audit.status, "pending_confirmation", "the lead's audit_site rule lets it run without asking");
    assert.match(audit.autoApproved ?? "", /auto-approved by the audit_site rule for agent lead/);

    const wf = byTool(out.toolCalls, "run_workflow");
    assert.equal(wf.status, "pending_confirmation", "Tier 2 always asks, whatever the rule says");
    assert.equal(wf.autoAction, undefined, "the chat must not offer auto for a Tier 2 action");
    assert.equal(out.awaitingConfirmation, true);

    // Stop the waiting task: the proposal is dropped, so "yes" runs nothing.
    await stopThreadRuns({ workspaceId: WS_A, threadId: t.id, userId: USER });
    const last = await prisma.aiChatMessage.findFirst({
      where: { threadId: t.id, role: "assistant" },
      orderBy: { createdAt: "desc" },
    });
    const calls = last!.toolCalls as unknown as ChatToolCall[];
    assert.equal(calls.find((c) => c.tool === "run_workflow")?.status, "cancelled");

    script = () => "Nothing is waiting on you.";
    const yes = await turn(t.id, "yes");
    assert.ok(!yes.toolCalls.some((c) => c.tool === "run_workflow" && c.status === "executed"));
  });

  it("stops a run mid-flight: aborts the model call, cancels the run, expires its approvals", async () => {
    const t = await thread("lead");
    let release: (() => void) | null = null;
    script = () =>
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("too late"), 20_000);
        timer.unref();
        release = () => {
          clearTimeout(timer);
          resolve("too late");
        };
      });
    const started = Date.now();
    const pending = turn(t.id, "Research every competitor in depth");

    let runId = "";
    for (let i = 0; i < 100 && !runId; i++) {
      const live = await listLiveThreadRuns(WS_A, t.id);
      runId = live[0]?.id ?? "";
      if (!runId) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(runId, "the turn should be a live run");

    // An approval this run raised (as executeTool records it on the timeline).
    const approval = await withWorkspaceScope(WS_A, (tx) =>
      tx.composioActionApproval.create({
        data: {
          workspaceId: WS_A,
          appKey: "ops",
          toolName: "OPS_INVOICE_SEND",
          riskTier: "medium",
          proposedArgs: {},
          plainSummary: "Send invoice INV-1",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    );
    await appendAgentRunEvent(WS_A, runId, { type: "agui", summary: "ops_send_invoice: proposed", payload: { approvalId: approval.id } });

    const stopped = await stopThreadRuns({ workspaceId: WS_A, threadId: t.id, userId: USER });
    assert.ok(stopped.includes(runId));
    const out = await pending;
    (release as (() => void) | null)?.();
    assert.equal(out.cancelled, true);
    assert.ok(Date.now() - started < 15_000, "the in-flight model call must be aborted, not waited out");
    assert.match(out.assistantText, /^Stopped/);

    const run = await getAgentRun(WS_A, runId);
    assert.equal(run?.status, "cancelled");
    assert.ok(run?.cancelRequestedAt);
    assert.equal(await isAgentRunCancelRequested(WS_A, runId), true);
    const after = await withWorkspaceScope(WS_A, (tx) =>
      tx.composioActionApproval.findFirst({ where: { id: approval.id, workspaceId: WS_A } }),
    );
    assert.equal(after?.status, "expired");
  });

  it("hands a task to one sub-agent as a child run that never exceeds its parent's grant", async () => {
    const t = await thread("lead", ["email"]);
    prompts.length = 0;
    script = (p) => {
      if (p.includes("Researcher sub-agent")) {
        return p.includes("TOOL DENIED") ? "Nothing I could look up with these tools." : toolCalls([{ tool: "research_question", args: { question: "rivals?" } }]);
      }
      return p.includes("TOOL RESULT (delegate_to_subagent)")
        ? "The Researcher reported back."
        : toolCalls([{ tool: "delegate_to_subagent", args: { agent: "researcher", task: "Look into competitors", tools: "web" } }]);
    };
    const out = await turn(t.id, "Find out what competitors are doing");

    const d = byTool(out.toolCalls, "delegate_to_subagent");
    assert.equal(d.status, "executed");
    assert.equal(d.delegated?.[0]?.tool, "research_question");
    assert.equal(d.delegated?.[0]?.status, "denied", "web was asked for but the parent never had it");
    assert.equal(d.delegated?.[0]?.agentKey, "researcher");

    const sub = prompts.find((p) => p.includes("Researcher sub-agent"));
    assert.ok(sub, "the sub-agent ran with its own role prompt");
    assert.doesNotMatch(sub!, /- research_question \[/);
    assert.doesNotMatch(sub!, /- delegate_to_subagent \[/, "sub-agents can't hand work off");

    const children = await withWorkspaceScope(WS_A, (tx) =>
      tx.agentRun.findMany({ where: { workspaceId: WS_A, parentRunId: out.runId } }),
    );
    assert.equal(children.length, 1);
    assert.equal(children[0]!.agentKey, "researcher");
    assert.deepEqual(children[0]!.allowedTools, ["workspace"]);
    assert.equal(children[0]!.status, "succeeded");
    assert.equal(children[0]!.threadId, t.id);
  });

  it("stopping only a sub-agent ends that sub-agent; the lead carries on", async () => {
    const t = await thread("lead");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    script = async (p) => {
      if (p.includes("Analyst sub-agent")) {
        await gate; // hold the sub-agent's first model call until the test stops it
        return toolCalls([{ tool: "get_keywords" }]);
      }
      return p.includes("TOOL RESULT (delegate_to_subagent)")
        ? "The lead finished without the Analyst."
        : toolCalls([{ tool: "delegate_to_subagent", args: { agent: "analyst", task: "Read the numbers" } }]);
    };
    const pending = turn(t.id, "What worked last month?");

    let child: { id: string } | null = null;
    for (let i = 0; i < 100 && !child; i++) {
      child = await withWorkspaceScope(WS_A, (tx) =>
        tx.agentRun.findFirst({ where: { workspaceId: WS_A, threadId: t.id, agentKey: "analyst", status: "running" }, select: { id: true } }),
      );
      if (!child) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(child, "the sub-agent run should be live");
    const res = await requestAgentRunCancel(WS_A, child!.id, USER);
    assert.deepEqual(res?.runIds, [child!.id], "stopping a child never reaches its parent");
    release();

    const out = await pending;
    assert.equal(out.cancelled, false);
    assert.equal(out.assistantText, "The lead finished without the Analyst.");
    const d = byTool(out.toolCalls, "delegate_to_subagent");
    assert.equal(d.status, "executed");
    assert.match(d.resultSummary ?? "", /Analyst was stopped before it finished/);
    assert.equal(d.delegated?.[0]?.status, "cancelled", "the sub-agent's next tool never ran");
    assert.equal((await getAgentRun(WS_A, child!.id))?.status, "cancelled");
    assert.equal((await getAgentRun(WS_A, out.runId))?.status, "succeeded");
  });

  it("RLS: another workspace can't see or stop the run", async () => {
    const t = await thread("lead");
    script = () => "Hello.";
    const out = await turn(t.id, "hi");
    assert.equal(await getAgentRun(WS_B, out.runId), null);
    assert.equal(await requestAgentRunCancel(WS_B, out.runId, "intruder"), null);
    assert.equal(await isAgentRunCancelRequested(WS_B, out.runId), false);
  });
});
