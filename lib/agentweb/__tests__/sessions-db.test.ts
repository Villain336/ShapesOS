// Phase 21A round 2 (WS=agentweb): Agent Sessions on real Postgres as the app role, through the real
// executeTool and the sessions route logic. The browser is the no-JavaScript provider over a fake
// network (no sockets).
//   - the first browser step of a run creates its session (it extends the run, no parallel run table);
//   - pause / resume, take over / hand back: the agent's steps (reads too) are refused while a
//     person is in control; a person's step goes through the SAME page-aware gate;
//   - review-each-step: a proposal waits, typed text is never stored, approve runs it as the
//     person's, reject tells the agent not to repeat it;
//   - step / credit caps stop the session and ask for a person; raising a cap resumes;
//   - the Phase 16 live-session limit; RLS; viewers cannot supervise; replay from the receipts.
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
import { createAgentwebTools, type AgentwebToolDeps } from "../tools";
import { HttpBrowserProvider } from "../provider-http";
import { webTasks } from "../tasks";
import { receiptSecret } from "../receipts";
import { storeCapture } from "../captures-store";
import { storeDelegation } from "../identity/delegation-store";
import { sessionGate, sessionStep, sessionNeeds } from "../sessions/gate";
import { ensureSession, getSessionView, listSessions, control, SessionError } from "../sessions/store";
import { handleSessionOp } from "../sessions/route-core";
import { loadReplay } from "../sessions/replay";
import "@/lib/agents/runs/browser-tools";

const RUN = `p21se-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const OTHER = `${RUN}-other`;
const USER = `${RUN}-user`;
let projectId = "";
const posts: string[] = [];
const PAGE = `<title>Shop</title><a href="/about">About</a><a href="/more">More</a>
<form action="/search" method="get"><input name="q" aria-label="Search"><button>Go</button></form>
<form action="/checkout/pay" method="post"><input autocomplete="cc-number" name="c" aria-label="Card"><button>Place order</button></form>`;
const fetchFn: typeof fetch = async (input, init) => {
  const url = String(input);
  if ((init?.method ?? "GET") === "POST") posts.push(url);
  return new Response(url === "https://shop.test/" ? PAGE : `<title>${url}</title><a href="/">Home</a>`, { status: 200 });
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
  recordEvent: async () => undefined,
  probe: async (origin, html) => ({ origin, html, files: {} }),
  registry: { recordProbe: async () => undefined, recordOutcome: async () => undefined, failedFor: async () => [] },
  saveScreenshot: async () => "blob:x",
  net: () => ({ fetchFn, checkUrl: async (u) => u }),
  sessions: { gate: (c, t, a, i) => sessionGate(c, t, a, i), step: (c, s) => sessionStep(c, s), needs: (c, r) => sessionNeeds(c, r) },
};

let n = 0;
let runId = "";
const newRun = async (ws = WS) => {
  const id = `${RUN}-run${++n}`;
  await withWorkspaceScope(ws, (tx) => tx.agentRun.create({ data: { id, workspaceId: ws, kind: "chat", status: "running", startedBy: USER, threadId: `${id}-thread`, agentKey: "lead" } }));
  return id;
};
const ctxFor = (rid: string, over: Partial<ToolContext> = {}): ToolContext & { threadId: string } => ({ projectId, workspaceId: WS, userId: USER, role: "owner", confirmed: false, agentKey: "lead", grant: null, runId: rid, threadId: `${rid}-thread`, ...over });
const call = (tool: string, args: Record<string, unknown>): ChatToolCall => ({ tool, args, status: "executed" });
const agent = async (tool: string, args: Record<string, unknown>, over: Partial<ToolContext> = {}) => {
  const c = call(tool, args);
  await executeTool(ctxFor(runId, over), tool, c.args, c);
  return c;
};
const owner = { userId: USER, workspaceId: WS, role: "owner" };
const op = (body: unknown, actor = owner, rid = runId) =>
  handleSessionOp(actor, new Request("https://app.test/api/agentweb/sessions/x", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", origin: "https://app.test" }, body: JSON.stringify(body) }), rid);
let refs: Record<string, string> = {};

async function startSession() {
  runId = await newRun();
  const nav = await agent("browser_navigate", { url: "https://shop.test/" });
  assert.equal(nav.status, "executed", nav.resultSummary);
  const snap = await agent("browser_snapshot", {});
  const find = (name: string) => new RegExp(`(e\\d+) \\w+ "${name}`).exec(snap.resultSummary ?? "")?.[1] ?? "";
  refs = { about: find("About"), more: find("More"), search: find("Search"), order: find("Place order") };
}

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
  // earlier tests' runs are over: only the live-session limit test counts live sessions
  await withWorkspaceScope(WS, (tx) => tx.agentRun.updateMany({ where: { workspaceId: WS }, data: { status: "succeeded" } }));
  await webTasks.closeAll();
  posts.length = 0;
});

describe("the session extends the run", () => {
  it("the first browser step creates it, counts steps and records where it is", async () => {
    await startSession();
    const s = (await getSessionView(WS, runId))!;
    assert.deepEqual([s.runKind, s.control, s.stepMode, s.live, s.status, s.origins, s.currentUrl], ["chat", "agent", "auto", true, "running", ["https://shop.test"], "https://shop.test/"]);
    assert.ok(s.steps >= 1);
    assert.equal((await listSessions(WS, { liveOnly: true })).some((x) => x.runId === runId), true);
  });
});

describe("pause, take over, hand back", () => {
  it("a paused session refuses the agent (reads too) until resumed", async () => {
    await startSession();
    assert.equal((await op({ op: "pause" })).status, 200);
    const click = await agent("browser_click", { ref: refs.about });
    assert.equal(click.status, "denied");
    assert.match(click.resultSummary!, /paused this session/);
    assert.equal((await agent("browser_snapshot", {})).status, "denied");
    assert.equal((await getSessionView(WS, runId))!.status, "needs", "paused is a state that needs a person");
    assert.equal((await op({ op: "resume" })).status, 200);
    assert.equal((await agent("browser_snapshot", {})).status, "executed");
  });

  it("take over: the agent is refused; the person's step goes through the same gate; hand back resumes the agent", async () => {
    await startSession();
    assert.equal((await op({ op: "step", tool: "browser_click", args: { ref: refs.about } })).status, 409, "no steps before taking over");
    assert.equal((await op({ op: "takeover" })).status, 200);
    const refused = await agent("browser_click", { ref: refs.about });
    assert.match(refused.resultSummary!, /taken over this session/);
    const ok = await op({ op: "step", tool: "browser_click", args: { ref: refs.about } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.ok, true);
    // the person cannot do what nobody may: the payment step is refused for them too
    const pay = await op({ op: "step", tool: "browser_click", args: { ref: refs.order } });
    assert.equal((await pay.json()).result.status, "denied");
    assert.deepEqual(posts, []);
    assert.equal((await op({ op: "handback" })).status, 200);
    const snap = await agent("browser_snapshot", {});
    assert.equal(snap.status, "executed");
  });

  it("a viewer cannot supervise, and a cross-site request is refused", async () => {
    await startSession();
    assert.equal((await op({ op: "pause" }, { ...owner, role: "viewer" })).status, 403);
    const cross = await handleSessionOp(owner, new Request("https://app.test/x", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ op: "pause" }) }), runId);
    assert.equal(cross.status, 403);
    assert.equal((await getSessionView(WS, runId))!.control, "agent");
  });
});

describe("review each step", () => {
  it("a proposal waits; typed text is never stored; approve runs it as the person's; the agent is told once", async () => {
    await startSession();
    await op({ op: "step_mode", mode: "approve_each" });
    const reads = await agent("browser_snapshot", {});
    assert.equal(reads.status, "executed", "reads still run");
    const typed = await agent("browser_type", { ref: refs.search, text: "secret-search-term-123" });
    assert.equal(typed.status, "denied");
    assert.match(typed.resultSummary!, /waiting for the person to approve or reject/);
    const s = (await getSessionView(WS, runId))!;
    assert.equal(s.needsReason, "proposal");
    assert.equal(s.pending!.tool, "browser_type");
    assert.ok(!JSON.stringify(s).includes("secret-search-term-123"), "typed text is not in the stored proposal");
    const again = await agent("browser_type", { ref: refs.search, text: "secret-search-term-123" });
    assert.equal(again.status, "denied");
    assert.equal((await getSessionView(WS, runId))!.pending!.id, s.pending!.id, "the same proposal is not duplicated");
    const approved = await op({ op: "approve", proposalId: s.pending!.id });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).result.ok, true);
    assert.equal((await getSessionView(WS, runId))!.pending, null);
    const next = await agent("browser_click", { ref: refs.about });
    assert.match(next.resultSummary!, /The person ran your proposed step/);
  });

  it("a rejected proposal is not repeated: the agent is told so", async () => {
    await startSession();
    await op({ op: "step_mode", mode: "approve_each" });
    await agent("browser_click", { ref: refs.more });
    const s = (await getSessionView(WS, runId))!;
    assert.equal((await op({ op: "reject", proposalId: s.pending!.id })).status, 200);
    const note = await agent("browser_click", { ref: refs.more });
    assert.match(note.resultSummary!, /rejected your proposed step/);
    assert.equal((await op({ op: "approve", proposalId: "prop_nope" })).status, 404);
  });

  it("the page-aware gate still refuses a payment step: it is not even proposed", async () => {
    await startSession();
    await op({ op: "step_mode", mode: "approve_each" });
    const pay = await agent("browser_click", { ref: refs.order });
    assert.match(pay.resultSummary!, /never does this step/);
    assert.equal((await getSessionView(WS, runId))!.pending, null);
  });
});

describe("caps", () => {
  it("the step cap stops the session and asks for a person; raising it resumes", async () => {
    await startSession();
    const steps = (await getSessionView(WS, runId))!.steps;
    assert.equal((await op({ op: "caps", maxSteps: steps })).status, 200);
    const blocked = await agent("browser_click", { ref: refs.about });
    assert.equal(blocked.status, "denied");
    assert.match(blocked.resultSummary!, /limit of \d+ steps/);
    assert.equal((await getSessionView(WS, runId))!.needsReason, "cap_steps");
    assert.equal((await op({ op: "caps", maxSteps: steps + 5 })).status, 200);
    assert.equal((await getSessionView(WS, runId))!.needsReason, null);
    assert.equal((await agent("browser_snapshot", {})).status, "executed");
  });

  it("caps are bounded", async () => {
    await startSession();
    assert.equal((await op({ op: "caps", maxSteps: 0 })).status, 409);
    assert.equal((await op({ op: "caps", maxCredits: 99999 })).status, 409);
  });
});

describe("limits and isolation", () => {
  it("a workspace cannot have more live browsing sessions than its delegation limit", async () => {
    const ws3 = `${RUN}-lim`;
    await prisma.workspace.create({ data: { id: ws3, name: ws3, ownerUserId: USER, plan: "pro" } });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const id = `${RUN}-lim${i}`;
        await withWorkspaceScope(ws3, (tx) => tx.agentRun.create({ data: { id, workspaceId: ws3, kind: "chat", status: "running", startedBy: USER } }));
        assert.deepEqual(await ensureSession(ws3, { runId: id, startedBy: USER, taskKey: `r:${id}` }), { ok: true, created: true });
        ids.push(id);
      }
      const extra = `${RUN}-lim-extra`;
      await withWorkspaceScope(ws3, (tx) => tx.agentRun.create({ data: { id: extra, workspaceId: ws3, kind: "chat", status: "running", startedBy: USER } }));
      const r = await ensureSession(ws3, { runId: extra, startedBy: USER, taskKey: `r:${extra}` });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "limit");
    } finally {
      await prisma.workspace.delete({ where: { id: ws3 } });
    }
  });

  it("another workspace sees and controls nothing; no GUC sees no rows", async () => {
    await startSession();
    assert.equal(await getSessionView(OTHER, runId), null);
    await assert.rejects(() => control(OTHER, runId, USER, "pause"), (e: unknown) => e instanceof SessionError && e.code === "not_found");
    assert.equal((await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM agentweb_sessions`)[0]!.n, 0);
  });

  it("deleting the run removes its session", async () => {
    await startSession();
    await withWorkspaceScope(WS, (tx) => tx.agentRun.delete({ where: { id: runId } }));
    assert.equal(await getSessionView(WS, runId), null);
  });
});

describe("replay from the receipts", () => {
  it("lists every step with its tier decision and verified receipt, without re-executing anything", async () => {
    await startSession();
    await agent("browser_click", { ref: refs.about }, { confirmed: true });
    const before = posts.length;
    const steps = await loadReplay(WS, runId);
    assert.ok(steps.length >= 3);
    assert.deepEqual(steps.slice(0, 2).map((s) => [s.action, s.decision]), [["navigate", "allow"], ["snapshot", "allow"]]);
    assert.ok(steps.every((s) => s.receipt && s.receipt.verified), "each step has a signed receipt");
    assert.ok(steps.every((s) => s.agent === "lead" && s.origin === "https://shop.test"));
    assert.equal(posts.length, before, "replay re-executes nothing");
  });
});
