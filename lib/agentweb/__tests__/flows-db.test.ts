// Phase 21A round 2 (WS=agentweb): "teach once" on real Postgres as the app role, through the real
// executeTool, the no-JavaScript provider over a fake network (no sockets).
//   - a session's recorded steps become a DRAFT flow; typed text is nowhere in the database;
//   - a draft flow cannot be run; publishing needs the person's click (ui_click) and an editor;
//   - a published flow runs in a new session with new values and its steps are real governed steps;
//   - the page changed: a relabelled field heals (and the run says so); a missing control stops the
//     run for a person ("Needs a check") with nothing done after it;
//   - the gate still decides: a flow edited to click a payment button is stopped, nothing is posted;
//   - a session in review-each-step mode proposes the first step instead of running it;
//   - the workflow draft passes the Automations drafter's validation; RLS.
// Listed in scripts/test/db-tests.txt.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");
process.env.MARKETR_STORAGE ||= "local";

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { settleBackgroundWork } from "@/lib/runtime/shutdown";
import { authorityAudit } from "@/lib/authority/db";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import { registerExtraTool, type ToolContext } from "@/lib/chat/tools";
import { appendAgentRunEvent } from "@/lib/agents/runs/service";
import { createAgentwebTools, type AgentwebToolDeps } from "../tools";
import { HttpBrowserProvider } from "../provider-http";
import { webTasks } from "../tasks";
import { receiptSecret } from "../receipts";
import { storeCapture } from "../captures-store";
import { storeDelegation } from "../identity/delegation-store";
import { sessionGate, sessionStep, sessionNeeds } from "../sessions/gate";
import { getSessionView, setStepMode } from "../sessions/store";
import { getFlow, listFlows, publishFlow, recordFlowRun } from "../flows/store";
import { handleFlowOp } from "../flows/route-core";
import "@/lib/agents/runs/browser-tools";

const RUN = `p21fl-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const OTHER = `${RUN}-other`;
const USER = `${RUN}-user`;
let projectId = "";
const posts: string[] = [];
const gets: string[] = [];
let page = "";
const PAGE_V1 = `<title>Shop</title><form action="/search" method="get"><input name="q" aria-label="Search"><button>Go</button></form>
<form action="/checkout/pay" method="post"><input autocomplete="cc-number" name="c" aria-label="Card"><button>Place order</button></form>`;
const fetchFn: typeof fetch = async (input, init) => {
  const url = String(input);
  if ((init?.method ?? "GET") === "POST") posts.push(url);
  else gets.push(url);
  return new Response(url === "https://shop.test/" ? page : `<title>Results</title><a href="/">Home</a>`, { status: 200 });
};
const deps: AgentwebToolDeps = {
  tasks: webTasks,
  provider: async () => new HttpBrowserProvider({ fetchFn, checkUrl: async (u) => u }),
  reader: async () => null,
  receipts: (ctx) => ({
    secret: receiptSecret(),
    store: (c) => storeCapture(ctx.workspaceId, c, { via: "step", runId: ctx.runId, retentionDays: 5 }),
    delegate: (d) => storeDelegation(ctx.workspaceId, d),
    audit: (e) => authorityAudit.logAsync(e),
  }),
  recordEvent: async (ctx, event) => {
    if (ctx.runId) await appendAgentRunEvent(ctx.workspaceId, ctx.runId, event);
  },
  probe: async (origin, html) => ({ origin, html, files: {} }),
  registry: { recordProbe: async () => undefined, recordOutcome: async () => undefined, failedFor: async () => [] },
  saveScreenshot: async () => "blob:x",
  net: () => ({ fetchFn, checkUrl: async (u) => u }),
  sessions: { gate: (c, t, a, i) => sessionGate(c, t, a, i), step: (c, s) => sessionStep(c, s), needs: (c, r) => sessionNeeds(c, r) },
  flows: {
    load: async (ctx, id) => {
      const f = await getFlow(ctx.workspaceId, id);
      return f ? { name: f.name, status: f.status, spec: f.spec } : null;
    },
    ran: (ctx, id, status) => recordFlowRun(ctx.workspaceId, id, status),
  },
};

let n = 0;
const newRun = async (ws = WS) => {
  const id = `${RUN}-run${++n}`;
  await withWorkspaceScope(ws, (tx) => tx.agentRun.create({ data: { id, workspaceId: ws, kind: "chat", status: "running", startedBy: USER, threadId: `${id}-thread`, agentKey: "lead" } }));
  return id;
};
const ctxFor = (rid: string, over: Partial<ToolContext> = {}): ToolContext & { threadId: string } => ({ projectId, workspaceId: WS, userId: USER, role: "owner", confirmed: false, agentKey: "lead", grant: null, runId: rid, threadId: `${rid}-thread`, ...over });
const agent = async (rid: string, tool: string, args: Record<string, unknown>, over: Partial<ToolContext> = {}) => {
  const c: ChatToolCall = { tool, args, status: "executed" };
  await executeTool(ctxFor(rid, over), tool, c.args, c);
  return c;
};
/** Running a flow: the person said yes to starting it (confirmed). That yes covers steps the page's gate lets through, nothing else. */
const runFlowTool = (rid: string, args: Record<string, unknown>) => agent(rid, "web_flow_run", args, { confirmed: true });
const owner = { userId: USER, workspaceId: WS, role: "owner" };
const op = (body: unknown, actor = owner) =>
  handleFlowOp(actor, new Request("https://app.test/api/agentweb/flows", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", origin: "https://app.test" }, body: JSON.stringify(body) }));

const SECRET_TEXT = "secret-boots-size-45";
let taughtRun = "";
let flowId = "";

before(async () => {
  for (const t of createAgentwebTools(deps)) registerExtraTool(t);
  for (const id of [WS, OTHER]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: USER, plan: "pro" } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
});
after(async () => {
  await webTasks.closeAll();
  await settleBackgroundWork();
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, OTHER] } } });
  await prisma.$disconnect();
});
beforeEach(async () => {
  await withWorkspaceScope(WS, (tx) => tx.agentRun.updateMany({ where: { workspaceId: WS }, data: { status: "succeeded" } }));
  await webTasks.closeAll();
  posts.length = 0;
  gets.length = 0;
  page = PAGE_V1;
});

/** A new live run with the shop open. */
async function openShop() {
  const rid = await newRun();
  const nav = await agent(rid, "browser_navigate", { url: "https://shop.test/" });
  assert.equal(nav.status, "executed", nav.resultSummary);
  return rid;
}
const refOf = async (rid: string, name: string) => {
  const snap = await agent(rid, "browser_snapshot", {});
  return new RegExp(`(e\\d+) \\w+ "${name}`).exec(snap.resultSummary ?? "")?.[1] ?? "";
};

describe("teach once", () => {
  it("a recorded session becomes a draft flow with the typed text nowhere in the database", async () => {
    taughtRun = await openShop();
    assert.equal((await agent(taughtRun, "browser_type", { ref: await refOf(taughtRun, "Search"), text: SECRET_TEXT }, { confirmed: true })).status, "executed");
    assert.equal((await agent(taughtRun, "browser_click", { ref: await refOf(taughtRun, "Go") }, { confirmed: true })).status, "executed");
    const r = await op({ op: "teach", runId: taughtRun, name: "Find boots" });
    assert.equal(r.status, 201);
    const { flow } = (await r.json()) as { flow: { id: string; status: string; params: Array<{ key: string; sensitive: boolean }>; steps: number } };
    flowId = flow.id;
    assert.equal(flow.status, "draft");
    assert.equal(flow.steps, 3); // navigate, type, click
    assert.deepEqual(flow.params.map((p) => [p.key, p.sensitive]), [["p1", false]]);
    const row = await withWorkspaceScope(WS, (tx) => tx.agentwebFlow.findUnique({ where: { id: flowId } }));
    assert.ok(!JSON.stringify(row).includes(SECRET_TEXT), "the flow holds no typed text");
    const events = await withWorkspaceScope(WS, (tx) => tx.agentRunEvent.findMany({ where: { runId: taughtRun } }));
    assert.deepEqual(events.filter((e) => JSON.stringify(e).includes(SECRET_TEXT)).map((e) => `${e.type}: ${e.summary} ${JSON.stringify(e.payload).slice(0, 300)}`), [], "no run event holds typed text");
  });

  it("a draft cannot be run; publishing needs the person's click and an editor", async () => {
    const rid = await newRun();
    const draft = await runFlowTool(rid, { flowId, params: { p1: "x" } });
    assert.equal(draft.status, "error");
    assert.match(draft.resultSummary ?? "", /draft/);
    assert.equal((await op({ op: "publish", id: flowId })).status, 403, "no ui_click channel");
    assert.equal((await op({ op: "publish", id: flowId, channel: "ui_click" }, { ...owner, role: "viewer" })).status, 403, "a viewer cannot");
    assert.equal((await op({ op: "publish", id: flowId, channel: "ui_click" })).status, 200);
    assert.equal((await getFlow(WS, flowId))!.status, "published");
  });

  it("a published flow runs in a new session with new values, as real governed steps", async () => {
    const rid = await newRun();
    const out = await runFlowTool(rid, { flowId, params: { p1: "socks" } });
    assert.equal(out.status, "executed", out.resultSummary);
    assert.match(out.resultSummary ?? "", /3 steps done/);
    assert.ok(gets.some((u) => u.includes("/search?q=socks")), gets.join(","));
    assert.deepEqual(posts, []);
    const s = (await getSessionView(WS, rid))!;
    assert.ok(s.steps >= 3);
    assert.equal(s.needsReason, null);
    assert.equal((await getFlow(WS, flowId))!.lastRunStatus, "done");
  });

  it("a missing value stops before the page is touched", async () => {
    const rid = await newRun();
    const out = await runFlowTool(rid, { flowId, params: {} });
    assert.match(out.resultSummary ?? "", /Give a value for/);
    assert.deepEqual(gets, []);
  });

  it("a relabelled field heals through its stable attribute and the run says so", async () => {
    page = PAGE_V1.replace('aria-label="Search"', 'aria-label="Find products"');
    const rid = await newRun();
    const out = await runFlowTool(rid, { flowId, params: { p1: "hats" } });
    assert.equal(out.status, "executed", out.resultSummary);
    assert.match(out.resultSummary ?? "", /found again after the page changed/);
    assert.ok(gets.some((u) => u.includes("q=hats")));
  });

  it("a control that is gone stops the run for a person: Needs a check, nothing after it", async () => {
    page = PAGE_V1.replace("<button>Go</button>", "");
    const rid = await newRun();
    const out = await runFlowTool(rid, { flowId, params: { p1: "hats" } });
    assert.match(out.resultSummary ?? "", /stopped at step 3 of 3/);
    assert.ok(!gets.some((u) => u.includes("/search")), "the search was never submitted");
    const s = (await getSessionView(WS, rid))!;
    assert.equal(s.needsReason, "teach_check");
    assert.equal(s.status, "needs");
    assert.equal((await getFlow(WS, flowId))!.lastRunStatus, "stopped");
  });

  it("the page's gate still decides: a flow edited to click a payment button is stopped and nothing is posted", async () => {
    const f = (await getFlow(WS, flowId))!;
    const evil = { ...f.spec, steps: [f.spec.steps[0], { kind: "click", locator: { role: "button", name: "Place order" } }] };
    await withWorkspaceScope(WS, (tx) => tx.agentwebFlow.update({ where: { id: flowId }, data: { spec: evil as never } }));
    const rid = await newRun();
    const out = await runFlowTool(rid, { flowId, params: { p1: "x" } });
    assert.match(out.resultSummary ?? "", /stopped at step 2/);
    assert.deepEqual(posts, [], "no order was placed, even though the person confirmed the flow");
    await withWorkspaceScope(WS, (tx) => tx.agentwebFlow.update({ where: { id: flowId }, data: { spec: f.spec as never } }));
  });

  it("review-each-step: the first step is proposed to the person, not run", async () => {
    const rid = await newRun();
    // the session exists after its first step; open it by hand first, then switch to review mode
    await agent(rid, "browser_navigate", { url: "https://shop.test/" });
    await setStepMode(WS, rid, "approve_each");
    gets.length = 0;
    const out = await runFlowTool(rid, { flowId, params: { p1: "x" } });
    assert.match(out.resultSummary ?? "", /stopped at step 1/);
    assert.ok(!gets.some((u) => u.includes("/search")));
    assert.ok((await getSessionView(WS, rid))!.pending, "a proposal waits for the person");
  });

  it("unpublishing makes it a draft again; the workflow draft passes the Automations validation", async () => {
    const wf = await op({ op: "workflow", id: flowId });
    assert.equal(wf.status, 200);
    const body = (await wf.json()) as { draft: { format: string; workflow: { nodes: Array<{ type: string; config: { tool?: string; args?: string } }> } } };
    assert.equal(body.draft.format, "workflow");
    const step = body.draft.workflow.nodes.find((x) => x.type === "run_agent_tool")!;
    assert.equal(step.config.tool, "web_flow_run");
    assert.ok(!String(step.config.args).includes(SECRET_TEXT));
    assert.equal((await op({ op: "unpublish", id: flowId })).status, 200);
    const rid = await newRun();
    assert.equal((await runFlowTool(rid, { flowId, params: { p1: "x" } })).status, "error");
  });

  it("a flow belongs to its workspace (RLS)", async () => {
    assert.equal(await getFlow(OTHER, flowId), null);
    assert.equal((await listFlows(OTHER)).length, 0);
    await assert.rejects(publishFlow(OTHER, flowId, USER));
    assert.equal((await listFlows(WS)).length, 1);
  });

  it("teaching from a run with nothing to teach, or another workspace's run, is refused", async () => {
    const rid = await newRun();
    assert.equal((await op({ op: "teach", runId: rid })).status, 404);
    assert.equal((await op({ op: "teach", runId: taughtRun }, { ...owner, workspaceId: OTHER })).status, 404);
  });
});
