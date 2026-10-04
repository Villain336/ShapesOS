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
// The model is a local fake of the OpenAI Responses API (POST /v1/responses,
// streamed as SSE) — the protocol the router actually uses here: with only
// OPENAI_API_KEY set, single-key mode routes the agent workloads to gpt-5.5
// on the Responses API. So the REAL Phase 8 agent loop (native tools,
// streaming), gates and run service run unchanged. Listed in
// scripts/test/db-tests.txt.
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
import { AgentWorker } from "@/lib/agents/queue/worker";
import { streamChatTurnAgui } from "@/lib/agents/agui/adapter";
import { EventType, assertAguiSequence, type AguiEvent } from "@/lib/agents/agui/events";

const RUN = `p5-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
let projectId = "";

// ---------------------------------------------------------------------------
// Fake model: the OpenAI Responses API (streaming)
// ---------------------------------------------------------------------------

interface ResponsesBody {
  instructions?: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<{ name: string }>;
  stream?: boolean;
}

interface Reply {
  text?: string;
  calls?: Array<{ tool: string; args?: Record<string, unknown> }>;
  /** Hold the stream after the first text delta until this settles. */
  holdAfterFirstDelta?: Promise<void>;
}

type Script = (body: ResponsesBody) => Reply | Promise<Reply>;
let script: Script = () => ({ text: "ok" });
const bodies: ResponsesBody[] = [];
let server: Server;
let callSeq = 0;

/** The function_call_output items the model got back (tool results). */
function toolOutputs(body: ResponsesBody): string[] {
  return body.input.filter((i) => i.type === "function_call_output").map((i) => String(i.output));
}

function calledTools(body: ResponsesBody): string[] {
  return body.input.filter((i) => i.type === "function_call").map((i) => String(i.name));
}

function offered(body: ResponsesBody): string[] {
  return (body.tools ?? []).map((t) => t.name);
}

/** Write one reply as Responses API SSE events (or one JSON body). */
async function respond(res: import("node:http").ServerResponse, body: ResponsesBody, reply: Reply): Promise<void> {
  const output: Array<Record<string, unknown>> = [];
  if (reply.text) output.push({ type: "message", content: [{ type: "output_text", text: reply.text }] });
  for (const c of reply.calls ?? []) {
    output.push({ type: "function_call", call_id: `call_${++callSeq}`, name: c.tool, arguments: JSON.stringify(c.args ?? {}) });
  }
  const response = { id: `resp_${callSeq}_${Date.now()}`, status: "completed", output, usage: { input_tokens: 10, output_tokens: 5 } };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (ev: Record<string, unknown>) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  for (const [output_index, item] of output.entries()) {
    if (item.type === "message") {
      const text = String((item.content as Array<{ text: string }>)[0]!.text);
      let first = true;
      for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
        send({ type: "response.output_text.delta", output_index, delta: piece });
        if (first && reply.holdAfterFirstDelta) await reply.holdAfterFirstDelta;
        first = false;
      }
    } else {
      send({ type: "response.output_item.added", output_index, item: { ...item, arguments: "" } });
      send({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments });
      send({ type: "response.output_item.done", output_index, item });
    }
  }
  send({ type: "response.completed", response });
  res.end();
}

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "LLM_MODEL_BULK",
  "LLM_MODEL",
  "LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "LLM_SELF_HOST",
  "LLM_MODEL_LEAD",
  "LLM_MODEL_SUBAGENT",
  "LLM_MODEL_CODE",
  "LLM_MODEL_CODE_MAX",
  "AGENT_WORKER",
];
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        if (!req.url?.endsWith("/responses")) throw new Error(`unexpected path ${req.url}`);
        const body = JSON.parse(raw) as ResponsesBody;
        bodies.push(body);
        const reply = await script(body);
        if (res.destroyed) return;
        await respond(res, body, reply);
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
  // No worker in this process: every turn runs inline.
  process.env.AGENT_WORKER = "off";

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

describe("Phase 5 agent controls (Phase 8 native loop, fake Responses API)", () => {
  it("limits a task's tools: hidden from the model, refused when named anyway", async () => {
    const t = await thread("drafter", ["email"]);
    bodies.length = 0;
    script = (b) =>
      toolOutputs(b).length > 0
        ? { text: "Done." }
        : {
            calls: [
              { tool: "research_question", args: { question: "What do rivals charge?" } },
              { tool: "get_keywords" },
              // The connector alias in its API-safe form (connector.<key>.<tool>).
              { tool: "connector__dataforseo__keyword_ideas", args: { seed: "espresso" } },
            ],
          };
    const out = await turn(t.id, "Draft the renewal email");

    const first = bodies[0]!;
    assert.match(first.instructions ?? "", /Writer sub-agent/);
    assert.ok(!offered(first).includes("research_question"), "an ungranted tool must not be offered");
    assert.ok(offered(first).includes("get_keywords"));
    // Every call got a tool_result back (results, denials) on the next turn.
    assert.equal(toolOutputs(bodies[1]!).length, 3);
    assert.ok(toolOutputs(bodies[1]!).some((o) => /Refused/.test(o)));

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
    script = () => ({
      calls: [
        { tool: "run_seo_audit", args: {} },
        { tool: "run_workflow", args: { workflowId: "wf-missing" } },
      ],
    });
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

    script = () => ({ text: "Nothing is waiting on you." });
    const yes = await turn(t.id, "yes");
    assert.ok(!yes.toolCalls.some((c) => c.tool === "run_workflow" && c.status === "executed"));
  });

  it("stops a run mid-flight: aborts the model call, cancels the run, expires its approvals", async () => {
    const t = await thread("lead");
    let release: (() => void) | null = null;
    script = () =>
      new Promise<Reply>((resolve) => {
        const timer = setTimeout(() => resolve({ text: "too late" }), 20_000);
        timer.unref();
        release = () => {
          clearTimeout(timer);
          resolve({ text: "too late" });
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
    bodies.length = 0;
    script = (b) => {
      if ((b.instructions ?? "").includes("Researcher sub-agent")) {
        return toolOutputs(b).some((o) => /Refused/.test(o))
          ? { text: "Nothing I could look up with these tools." }
          : { calls: [{ tool: "research_question", args: { question: "rivals?" } }] };
      }
      return calledTools(b).includes("delegate_to_subagent")
        ? { text: "The Researcher reported back." }
        : { calls: [{ tool: "delegate_to_subagent", args: { agent: "researcher", task: "Look into competitors", tools: "web" } }] };
    };
    const out = await turn(t.id, "Find out what competitors are doing");

    const d = byTool(out.toolCalls, "delegate_to_subagent");
    assert.equal(d.status, "executed");
    assert.equal(d.delegated?.[0]?.tool, "research_question");
    assert.equal(d.delegated?.[0]?.status, "denied", "web was asked for but the parent never had it");
    assert.equal(d.delegated?.[0]?.agentKey, "researcher");

    const sub = bodies.find((b) => (b.instructions ?? "").includes("Researcher sub-agent"));
    assert.ok(sub, "the sub-agent ran with its own role prompt");
    assert.ok(!offered(sub!).includes("research_question"));
    assert.ok(!offered(sub!).includes("delegate_to_subagent"), "sub-agents can't hand work off");

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
    script = async (b) => {
      if ((b.instructions ?? "").includes("Analyst sub-agent")) {
        await gate; // hold the sub-agent's first model call until the test stops it
        return { calls: [{ tool: "get_keywords" }] };
      }
      return calledTools(b).includes("delegate_to_subagent")
        ? { text: "The lead finished without the Analyst." }
        : { calls: [{ tool: "delegate_to_subagent", args: { agent: "analyst", task: "Read the numbers" } }] };
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

  it("Phase 8: after \"yes\" the model carries on from the transcript with the real result", async () => {
    const t = await thread("lead");
    bodies.length = 0;
    script = (b) => {
      const outs = toolOutputs(b);
      if (outs.length === 0) return { calls: [{ tool: "run_workflow", args: { workflowId: "wf-nope" } }] };
      return outs.some((o) => /waiting for the user's OK/.test(o)) ? { text: "should not happen" } : { text: "Continued after your OK." };
    };
    const proposed = await turn(t.id, "Run the weekly workflow");
    assert.equal(proposed.awaitingConfirmation, true);
    const pending = byTool(proposed.toolCalls, "run_workflow");
    assert.ok(pending.toolUseId && pending.runId, "the proposal remembers its transcript");

    const yes = await turn(t.id, "yes");
    const ran = byTool(yes.toolCalls, "run_workflow");
    assert.equal(ran.confirmed, true);
    assert.notEqual(ran.status, "pending_confirmation");
    assert.equal(yes.assistantText, "Continued after your OK.");
    const cont = bodies[bodies.length - 1]!;
    assert.ok(!toolOutputs(cont).some((o) => /waiting for the user's OK/.test(o)), "the placeholder result was replaced");
    assert.ok(calledTools(cont).includes("run_workflow"), "same transcript: the original call is still there");
  });

  it("Phase 8: a long turn hands off to the worker, which finishes it from the saved transcript", async () => {
    const t = await thread("lead");
    let modelCalls = 0;
    script = (b) => {
      modelCalls++;
      return toolOutputs(b).length > 0 ? { text: "Finished in the background." } : { calls: [{ tool: "get_keywords" }] };
    };
    // A 1 ms inline budget: the turn hands off after its first step.
    const out = await runTrackedAgentTurn(
      { projectId, workspaceId: WS_A, userId: USER, role: "editor", threadId: t.id, userContent: "Look at my keywords" },
      { inlineBudgetMs: 1 },
    );
    assert.equal(out.queued, true);
    assert.equal(modelCalls, 1, "one step ran inline");
    assert.equal((await getAgentRun(WS_A, out.runId))?.status, "running", "still running on the queue");
    const jobs = await withWorkspaceScope(WS_A, (tx) => tx.agentJob.findMany({ where: { workspaceId: WS_A, runId: out.runId } }));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.kind, "chat_turn");

    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const worker = new AgentWorker({ log: quiet, leaseMs: 60_000, heartbeatMs: 10_000 });
    await worker.tick();
    const outcomes = await worker.drain();
    assert.ok(outcomes.some((o) => o.jobId === jobs[0]!.id && o.status === "succeeded"), JSON.stringify(outcomes));
    assert.equal(modelCalls, 2, "the worker continued with the next step, not from scratch");
    const run = await getAgentRun(WS_A, out.runId);
    assert.equal(run?.status, "succeeded");
    const last = await prisma.aiChatMessage.findFirst({ where: { threadId: t.id, role: "assistant" }, orderBy: { createdAt: "desc" } });
    assert.equal(last?.content, "Finished in the background.");
    const calls = last!.toolCalls as unknown as ChatToolCall[];
    assert.equal(calls.filter((c) => c.tool === "get_keywords" && c.status === "executed").length, 1, "the tool ran once");
  });

  it("Phase 8: the AG-UI stream carries text deltas while the model is still writing", async () => {
    const t = await thread("lead");
    let observed: () => void = () => undefined;
    const sawFirstDelta = new Promise<void>((r) => (observed = r));
    // The fake model holds its stream after the first word until the TEST has
    // seen that word on the AG-UI stream: replaying finished output would
    // deadlock here (the test times out).
    script = () => ({ text: "Streaming works word by word.", holdAfterFirstDelta: sawFirstDelta });
    const events: AguiEvent[] = [];
    for await (const e of streamChatTurnAgui(
      { projectId, workspaceId: WS_A, userId: USER, role: "editor", threadId: t.id, userContent: "Say something", runId: "agui-live" },
      { loadSharedState: async () => ({}), logSink: () => undefined, pollMs: 50 },
    )) {
      events.push(e);
      if (e.type === EventType.TEXT_MESSAGE_CONTENT) observed();
    }
    assertAguiSequence(events);
    const deltas = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => (e as { delta: string }).delta);
    assert.ok(deltas.length >= 1);
    assert.equal(deltas.join(""), "Streaming works word by word.");
    assert.equal(events[events.length - 1]!.type, EventType.RUN_FINISHED);
  });

  it("RLS: another workspace can't see or stop the run", async () => {
    const t = await thread("lead");
    script = () => ({ text: "Hello." });
    const out = await turn(t.id, "hi");
    assert.equal(await getAgentRun(WS_B, out.runId), null);
    assert.equal(await requestAgentRunCancel(WS_B, out.runId, "intruder"), null);
    assert.equal(await isAgentRunCancelRequested(WS_B, out.runId), false);
  });
});
