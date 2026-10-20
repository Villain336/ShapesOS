// ShapesOS — Phase 18.3 (WS=trust) DB test: agent app permissions.
//   - an admin blocks Mail for agents (audited; the setting is per workspace);
//   - a thread's next turn is granted without "email", the model's tool list
//     (toolCatalogForPrompt) loses the mail tools, and the Store marks Gmail
//     blocked;
//   - at EXECUTE time a mail tool is refused even with no task grant at all,
//     and even when the run's stored grant still names "email";
//   - another workspace is untouched; allowing it again restores today's behaviour.
// Real Postgres as the least-privilege app role.
// Run: DATABASE_URL=<app role> npx tsx --test lib/agents/__tests__/app-permissions-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "@/lib/chat/tools";
import type { ChatToolCall } from "@/lib/chat/tool-exec";

const RUN = randomUUID().slice(0, 8);
const WS = `apps-ws-${RUN}`;
const WS_B = `apps-wsb-${RUN}`;
const OWNER = `apps-owner-${RUN}`;

let prisma: typeof import("@/lib/prisma").prisma;
let perms: typeof import("../app-permissions");
let exec: typeof import("@/lib/chat/tool-exec");
let tools: typeof import("@/lib/chat/tools");
let agent: typeof import("@/lib/chat/agent");
let projectId = "";
let threadId = "";

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  perms = await import("../app-permissions");
  agent = await import("@/lib/chat/agent");
  exec = await import("@/lib/chat/tool-exec");
  tools = await import("@/lib/chat/tools");
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: OWNER } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: OWNER, role: "owner" } });
  const p = await prisma.project.create({ data: { workspaceId: WS, domain: `apps-${RUN}.example` } });
  projectId = p.id;
  const t = await prisma.aiChatThread.create({ data: { projectId, userId: OWNER, title: "t", agentKey: "lead", allowedTools: [] } });
  threadId = t.id;
});

after(async () => {
  await prisma.fileChangeLog.deleteMany({ where: { workspaceId: { in: [WS, WS_B] } } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_B] } } });
  await prisma.$disconnect();
});

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ projectId, workspaceId: WS, userId: OWNER, role: "owner", confirmed: true, agentKey: "lead", grant: null, ...over }) as ToolContext;
const call = (tool: string): ChatToolCall => ({ tool, args: {}, status: "pending_confirmation" });

describe("agent app permissions (DB)", () => {
  it("default: nothing blocked — today's behaviour", async () => {
    assert.deepEqual(await perms.getAgentBlockedGroups(WS, { fresh: true }), []);
    const profile = await agent.threadTaskProfile(threadId);
    assert.ok(profile.grant.includes("email"));
  });

  it("an admin blocks Mail: audited, and only this workspace", async () => {
    await perms.setAgentBlockedGroups(WS, ["email"], OWNER);
    assert.deepEqual(await perms.getAgentBlockedGroups(WS, { fresh: true }), ["email"]);
    assert.deepEqual(await perms.getAgentBlockedGroups(WS_B, { fresh: true }), []);
    const audit = await prisma.fileChangeLog.findFirst({ where: { workspaceId: WS, action: "agent_app_access_changed" } });
    assert.match(audit?.summary ?? "", /Blocked agents from Email/);
    assert.equal(audit?.approvedBy, OWNER);
    await assert.rejects(perms.setAgentBlockedGroups(WS, ["workspace"], OWNER), /can't be blocked/);
  });

  it("the next turn's grant and the model's tool list drop the mail tools", async () => {
    const profile = await agent.threadTaskProfile(threadId);
    assert.ok(!profile.grant.includes("email"), "grant without email");
    assert.ok(profile.grant.includes("web"));
    const catalog = tools.toolCatalogForPrompt(profile.grant);
    assert.doesNotMatch(catalog, /- mail_send \[/);
    assert.doesNotMatch(catalog, /- mail_list_threads \[/);
    assert.match(tools.toolCatalogForPrompt(null), /- mail_list_threads \[/, "control: the tool exists");
  });

  it("execute time: a mail tool is refused with no grant, and with a stale grant that still names email", async () => {
    for (const grant of [null, ["workspace", "email"]] as const) {
      const c = call("mail_list_threads");
      const r = await exec.executeTool(ctx({ grant: grant as never }), "mail_list_threads", {}, c);
      assert.equal(r, null);
      assert.equal(c.status, "denied", `grant ${JSON.stringify(grant)}`);
      assert.match(c.resultSummary ?? "", /Agents may not use Email in this workspace/);
    }
    // Connector tools of the blocked app too (Gmail is "email").
    const g = call("connector.gmail.list_messages");
    await exec.executeTool(ctx(), "connector.gmail.list_messages", {}, g);
    assert.equal(g.status, "denied");
    assert.match(g.resultSummary ?? "", /Agents may not use Email/);
    // Another app still runs through the normal gates.
    const w = call("list_reminders");
    await exec.executeTool(ctx(), "list_reminders", {}, w);
    assert.notEqual(w.status, "denied");
  });

  it("the Store shows Gmail blocked for agents", async () => {
    const { loadStoreCatalogue } = await import("@/lib/store/service");
    const cat = await loadStoreCatalogue({ workspaceId: WS, userId: OWNER, role: "owner" } as never);
    const gmail = cat.items.find((i) => i.kind === "connector" && i.key === "gmail");
    assert.deepEqual(gmail?.agentAccess, { group: "email", blocked: true });
    const ga4 = cat.items.find((i) => i.kind === "connector" && i.key === "ga4");
    if (ga4) assert.equal(ga4.agentAccess?.blocked, false);
  });

  it("allowing it again restores the grant", async () => {
    await perms.setAgentBlockedGroups(WS, [], OWNER);
    perms.clearAgentAppPermissionCache();
    const profile = await agent.threadTaskProfile(threadId);
    assert.ok(profile.grant.includes("email"));
    const audit = await prisma.fileChangeLog.findMany({ where: { workspaceId: WS, action: "agent_app_access_changed" }, orderBy: { createdAt: "asc" } });
    assert.match(audit.at(-1)?.summary ?? "", /Allowed agents to use Email/);
  });
});
