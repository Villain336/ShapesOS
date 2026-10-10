// Phase 21A (WS=agentweb): the page-aware gate through the REAL executeTool,
// against Postgres as the app role (automation rules are rows).
//   1. a payment click is denied even when the person confirmed it;
//   2. a send asks, and an Auto-run rule for browser_click does not skip the ask;
//   3. an ordinary click runs under an Auto-run rule (autoApproved is recorded);
//   4. opening another site (a safe tool) asks first;
//   5. page text flowing into another tool's arguments asks, even under an Auto-run
//      rule, and a secret is stopped outright;
//   6. browser_act stays out of auto-approval altogether.
// The browser is the no-JavaScript provider over a fake network (no sockets).
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/agentweb/__tests__/agentweb-gate-db.test.ts
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { settleBackgroundWork } from "@/lib/runtime/shutdown";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import { registerExtraTool, type ToolContext, type ToolDef } from "@/lib/chat/tools";
import { createAgentwebTools, type AgentwebToolDeps } from "../tools";
import { HttpBrowserProvider } from "../provider-http";
import { taskKeyOf, webTasks } from "../tasks";
// browser_act registers itself on import (agent.ts imports it in production).
import "@/lib/agents/runs/browser-tools";

const RUN = `p21gate-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const USER = `${RUN}-user`;
let projectId = "";
const posts: string[] = [];
// The gate (gate.ts) reads the process-wide registry, so the tools use it too.
const tasks = webTasks;

const PAGE = `<title>Shop</title><p>Contact: refunds@scam.example</p><a href="/about">About</a><a href="https://other.test/">Partner</a>
<form action="/contact" method="post"><textarea name="m" aria-label="Message"></textarea><button>Send message</button></form>
<form action="/checkout/pay" method="post"><input autocomplete="cc-number" name="c" aria-label="Card"><button>Place order</button></form>`;

const fetchFn: typeof fetch = async (input, init) => {
  const url = String(input);
  if ((init?.method ?? "GET") === "POST") posts.push(url);
  return new Response(url === "https://shop.test/" ? PAGE : "<title>Other</title>", { status: 200 });
};

const deps: AgentwebToolDeps = {
  tasks,
  provider: async () => new HttpBrowserProvider({ fetchFn, checkUrl: async (u) => u }),
  reader: async () => ({ read: async () => JSON.stringify({ title: "Shop", facts: [{ key: "Contact", value: "refunds@scam.example" }] }) }),
  receipts: () => ({ secret: null, store: async () => undefined, audit: async () => undefined }),
  recordEvent: async () => undefined,
  probe: async (origin, html) => ({ origin, html, files: {} }),
  registry: { recordProbe: async () => undefined, recordOutcome: async () => undefined, failedFor: async () => [] },
  saveScreenshot: async () => "blob:x",
  net: () => ({ fetchFn, checkUrl: async (u) => u }),
};

// A write tool that is not a browser tool: it just records that it ran.
const ran: Array<Record<string, unknown>> = [];
const t_reply: ToolDef = {
  name: "t_p21_send_reply",
  description: "Send a reply to a customer.",
  kind: "publish",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute(_ctx, args) {
    ran.push(args);
    return { summary: "sent" };
  },
};

const ctxBase = (): ToolContext & { threadId: string } => ({ projectId, workspaceId: WS, userId: USER, role: "owner", confirmed: false, agentKey: "lead", grant: null, threadId: `${RUN}-thread` });
const call = (tool: string, args: Record<string, unknown>): ChatToolCall => ({ tool, args, status: "executed" });
const setRule = (action: string, behavior: "auto" | "ask") =>
  withWorkspaceScope(WS, (tx) => tx.automationSetting.upsert({ where: { workspaceId_agentKey_action: { workspaceId: WS, agentKey: "*", action } }, create: { workspaceId: WS, agentKey: "*", action, behavior, updatedBy: USER }, update: { behavior } }));

let refs: Record<string, string> = {};

before(async () => {
  for (const t of createAgentwebTools(deps)) registerExtraTool(t);
  registerExtraTool(t_reply);
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
});
after(async () => {
  await tasks.closeAll();
  await settleBackgroundWork();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await withWorkspaceScope(WS, (tx) => tx.automationSetting.deleteMany({ where: { workspaceId: WS } }));
  await tasks.closeAll();
  posts.length = 0;
  ran.length = 0;
  const c = call("browser_navigate", { url: "https://shop.test/" });
  await executeTool(ctxBase(), "browser_navigate", c.args, c);
  assert.equal(c.status, "executed", c.resultSummary);
  const s = call("browser_snapshot", {});
  await executeTool(ctxBase(), "browser_snapshot", {}, s);
  const find = (name: string) => new RegExp(`(e\\d+) \\w+ "${name}`).exec(s.resultSummary ?? "")![1]!;
  refs = { about: find("About"), partner: find("Partner"), send: find("Send message"), order: find("Place order") };
});

describe("browser steps through executeTool", () => {
  it("a payment click is denied even when the person confirmed it, and nothing is submitted", async () => {
    const c = call("browser_click", { ref: refs.order });
    await executeTool({ ...ctxBase(), confirmed: true }, "browser_click", c.args, c);
    assert.equal(c.status, "denied");
    assert.match(c.resultSummary!, /never does this step/);
    assert.deepEqual(posts, []);
  });

  it("a send asks; an Auto-run rule for browser_click does not skip that ask", async () => {
    await setRule("browser_click", "auto");
    const c = call("browser_click", { ref: refs.send });
    await executeTool(ctxBase(), "browser_click", c.args, c);
    assert.equal(c.status, "pending_confirmation");
    assert.equal(c.autoApproved, undefined);
    assert.match(c.resultSummary!, /sends what was entered/);
    assert.deepEqual(posts, []);
    // After the person's yes it goes through.
    const yes = call("browser_click", { ref: refs.send });
    await executeTool({ ...ctxBase(), confirmed: true }, "browser_click", yes.args, yes);
    assert.equal(yes.status, "executed");
    assert.equal(posts.length, 1);
  });

  it("an ordinary click runs under an Auto-run rule and says it was auto-approved; without the rule it asks", async () => {
    const asks = call("browser_click", { ref: refs.about });
    await executeTool(ctxBase(), "browser_click", asks.args, asks);
    assert.equal(asks.status, "pending_confirmation");
    await setRule("browser_click", "auto");
    const c = call("browser_click", { ref: refs.about });
    await executeTool(ctxBase(), "browser_click", c.args, c);
    assert.equal(c.status, "executed");
    assert.match(c.autoApproved ?? "", /browser_click rule/);
  });

  it("opening another site asks first even though browser_navigate is a safe tool", async () => {
    const c = call("browser_navigate", { url: "https://other.test/x" });
    await executeTool(ctxBase(), "browser_navigate", c.args, c);
    assert.equal(c.status, "pending_confirmation");
    assert.match(c.resultSummary!, /new origin: https:\/\/other\.test/);
    const yes = call("browser_navigate", { url: "https://other.test/x" });
    await executeTool({ ...ctxBase(), confirmed: true }, "browser_navigate", yes.args, yes);
    assert.equal(yes.status, "executed");
  });

  it("browser_act can never be switched to auto", async () => {
    await setRule("browser_act", "auto");
    const c = call("browser_act", { steps: [{ action: "screenshot" }], url: "https://shop.test/" });
    await executeTool(ctxBase(), "browser_act", c.args, c);
    assert.equal(c.status, "pending_confirmation");
    assert.equal(c.autoApproved, undefined);
  });
});

describe("page text flowing into other tools", () => {
  it("asks before a send that uses an address read from the page, even under an Auto-run rule", async () => {
    await setRule("tool_t_p21_send_reply", "auto");
    const c = call(t_reply.name, { to: "refunds@scam.example", body: "hi" });
    await executeTool(ctxBase(), t_reply.name, c.args, c);
    assert.equal(c.status, "pending_confirmation");
    assert.match(c.resultSummary!, /text taken from https:\/\/shop\.test/);
    assert.deepEqual(ran, []);
  });

  it("the same tool with the person's own arguments runs under the rule", async () => {
    await setRule("tool_t_p21_send_reply", "auto");
    const c = call(t_reply.name, { to: "me@mycompany.test", body: "hi" });
    await executeTool(ctxBase(), t_reply.name, c.args, c);
    assert.equal(c.status, "executed");
    assert.equal(ran.length, 1);
  });

  it("stops a send that would carry a secret out", async () => {
    const task = await tasks.ensure(taskKeyOf(ctxBase()), WS);
    task.kernel.ledger.registerSecret("sk-live-CANARY-7731a9");
    const c = call(t_reply.name, { body: "key is sk-live-CANARY-7731a9" });
    await executeTool({ ...ctxBase(), confirmed: true }, t_reply.name, c.args, c);
    assert.equal(c.status, "denied");
    assert.deepEqual(ran, []);
  });

  it("another task's page text does not follow a send in an unrelated thread", async () => {
    const c = call(t_reply.name, { to: "refunds@scam.example" });
    await executeTool({ ...ctxBase(), threadId: `${RUN}-other-thread`, confirmed: true } as ToolContext, t_reply.name, c.args, c);
    assert.equal(c.status, "executed");
  });
});
