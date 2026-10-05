// Phase 11 (conncore): the Slack app against Postgres (as the app role).
//   1. recordSlackInstall maps the team to the workspace under FORCE RLS;
//      another workspace installing the same team is refused.
//   2. routeSlackTeam finds it through the SELECT-only route policy; without
//      the route GUC (or a tenant GUC) nothing is visible.
//   3. Event receipts dedupe by event id.
//   4. runSlackMention: the first mention creates a chat thread + link and
//      runs a turn as the installer; a follow-up in the same Slack thread
//      continues the same chat thread; a busy thread re-queues; the reply
//      is posted into the Slack thread. (The model and Slack are stubbed.)
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/slack/__tests__/slack-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { countWithoutScope, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { recordSlackInstall, routeSlackTeam, SlackInstallConflictError } from "../install";
import { defaultSlackEventsDeps, type SlackMentionJobPayload } from "../events";
import { runSlackMention, type MentionDeps } from "../mention";

const RUN = `p11s-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
const TEAM = `T${Date.now().toString(36).toUpperCase().slice(-8)}`;
let projectId = "";
let connectionId = "";

before(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: `P11 ${id}`, ownerUserId: USER } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS_A, userId: USER, role: "editor", email: `${RUN}@example.com` } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}.example` } })).id;
  connectionId = (
    await prisma.connectorConnection.create({ data: { connectorKey: "slack", workspaceId: WS_A, userId: USER, status: "active", scopes: [] } })
  ).id;
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("Slack installs (RLS + routing)", () => {
  it("records the install for the workspace with its default project", async () => {
    const row = await recordSlackInstall({ workspaceId: WS_A, userId: USER, connectionId, meta: { slackTeamId: TEAM, slackTeamName: "Acme", slackBotUserId: "U0BOT001" } });
    assert.equal(row.teamId, TEAM);
    assert.equal(row.projectId, projectId);
    assert.equal(row.installedBy, USER);
    // Re-install is idempotent.
    const again = await recordSlackInstall({ workspaceId: WS_A, userId: USER, connectionId, meta: { slackTeamId: TEAM } });
    assert.equal(again.id, row.id);
  });

  it("refuses the same Slack team for another workspace", async () => {
    await assert.rejects(
      recordSlackInstall({ workspaceId: WS_B, userId: USER, connectionId, meta: { slackTeamId: TEAM } }),
      SlackInstallConflictError,
    );
  });

  it("routes team → workspace only through the route policy; tenants are isolated", async () => {
    const route = await routeSlackTeam(TEAM);
    assert.equal(route?.workspaceId, WS_A);
    assert.equal(route?.connectionId, connectionId);
    assert.equal(await routeSlackTeam("T0NOPE0001"), null);
    assert.equal(await countWithoutScope("slack_installations"), 0, "no GUC → no rows (FORCE RLS)");
    const seenByB = await withWorkspaceScope(WS_B, (tx) => tx.slackInstallation.count());
    assert.equal(seenByB, 0);
    // The route policy is SELECT-only: it can't be used to write.
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.slack_route = 'lookup'`);
        await tx.slackInstallation.updateMany({ where: { teamId: TEAM }, data: { enabled: false } }).then((r) => {
          if (r.count === 0) throw new Error("no rows updated");
        });
      }),
    );
  });

  it("event receipts dedupe by event id", async () => {
    const row = { eventId: `Ev${RUN.replace(/[^a-z0-9]/gi, "")}`, workspaceId: WS_A, teamId: TEAM, eventType: "app_mention", outcome: "queued" };
    assert.equal(await defaultSlackEventsDeps.receipt(row), true);
    assert.equal(await defaultSlackEventsDeps.receipt(row), false);
  });
});

describe("Slack mention → agent task", () => {
  const posts: Array<{ channel: string; threadTs: string; text: string }> = [];
  const turns: Array<{ threadId: string; userId: string; userContent: string }> = [];
  const requeued: SlackMentionJobPayload[] = [];
  let busy: string | null = null;
  const deps: MentionDeps = {
    runTurn: async (input) => {
      turns.push(input);
      await prisma.aiChatMessage.create({ data: { threadId: input.threadId, role: "assistant", content: "Drafted it." } });
      return { runId: `run-${turns.length}`, assistantText: "Drafted it.", awaitingConfirmation: turns.length === 2 };
    },
    threadBusy: async () => busy,
    roleOf: async (userId, workspaceId) => (await prisma.workspaceMember.findFirst({ where: { userId, workspaceId }, select: { role: true } }))?.role ?? null,
    requeue: async (payload) => void requeued.push(payload),
    post: async (_conn, channel, threadTs, text) => void posts.push({ channel, threadTs, text }),
    appUrl: () => "https://app.example.com",
    now: () => new Date(),
  };
  let installationId = "";
  const base = (): SlackMentionJobPayload => ({
    workspaceId: WS_A,
    installationId,
    eventId: "Ev0X",
    teamId: TEAM,
    eventType: "app_mention",
    channel: "C0CHAN001",
    user: "U0USER01",
    ts: "1760000000.000100",
    threadTs: "1760000000.000100",
    text: "draft the launch post",
  });

  before(async () => {
    installationId = (await routeSlackTeam(TEAM))!.id;
  });

  it("the first mention creates a chat thread + link, runs as the installer and replies in Slack", async () => {
    const out = await runSlackMention(base(), deps);
    assert.equal(out.status, "answered");
    if (out.status !== "answered") return;
    const thread = await prisma.aiChatThread.findUnique({ where: { id: out.chatThreadId } });
    assert.equal(thread?.projectId, projectId);
    assert.equal(thread?.userId, USER);
    assert.equal(turns[0].userId, USER);
    assert.match(turns[0].userContent, /^Slack message from Slack user U0USER01 in channel C0CHAN001:\n> draft the launch post/);
    const link = await withWorkspaceScope(WS_A, (tx) => tx.slackThreadLink.findFirst({ where: { teamId: TEAM, channelId: "C0CHAN001", threadTs: "1760000000.000100" } }));
    assert.equal(link?.chatThreadId, out.chatThreadId);
    assert.equal(link?.lastRunId, "run-1");
    assert.deepEqual(posts[0], { channel: "C0CHAN001", threadTs: "1760000000.000100", text: "Drafted it." });
  });

  it("a follow-up in the same Slack thread continues the same chat thread; waiting turns link the run", async () => {
    const first = turns[0].threadId;
    const out = await runSlackMention({ ...base(), eventId: "Ev0Y", ts: "1760000050.000100", text: "make it shorter" }, deps);
    assert.equal(out.status === "answered" && out.chatThreadId, first);
    assert.match(posts[1].text, /needs your OK in ShapesOS before anything is changed: https:\/\/app\.example\.com\/dashboard\/runs\/run-2/);
    const msgs = await prisma.aiChatMessage.count({ where: { threadId: first, role: "user" } });
    assert.equal(msgs, 2);
  });

  it("a busy thread re-queues with backoff instead of running", async () => {
    busy = "a run is still working in this thread";
    const out = await runSlackMention({ ...base(), eventId: "Ev0Z", text: "and the email" }, deps);
    busy = null;
    assert.equal(out.status, "deferred");
    assert.equal(requeued.length, 1);
    assert.equal(requeued[0].deferrals, 1);
    assert.equal(turns.length, 2);
  });

  it("a disabled install or an installer who left stops the task", async () => {
    await withWorkspaceScope(WS_A, (tx) => tx.slackInstallation.updateMany({ where: { teamId: TEAM }, data: { enabled: false } }));
    assert.equal((await runSlackMention(base(), deps)).status, "skipped");
    await withWorkspaceScope(WS_A, (tx) => tx.slackInstallation.updateMany({ where: { teamId: TEAM }, data: { enabled: true } }));
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: WS_A, userId: USER } });
    const out = await runSlackMention(base(), deps);
    assert.equal(out.status, "skipped");
    assert.match(posts[posts.length - 1].text, /no longer a member/);
  });
});

// ---------------------------------------------------------------------------
// Phase 14 (approvals): Slack replies follow the slack_reply rule.
// ---------------------------------------------------------------------------

import { SLACK_PLACEHOLDER_TEXT, SLACK_REPLY_TOOL } from "../mention";
import { runAgentTurn, type ChatToolCall } from "@/lib/chat/agent";

describe("Phase 14: Slack reply approval", () => {
  const posts: Array<{ channel: string; threadTs: string; text: string }> = [];
  const held: Array<{ sourceId: string; title: string; href: string }> = [];
  let n = 0;
  const deps: MentionDeps = {
    runTurn: async (input) => {
      n++;
      await prisma.aiChatMessage.create({ data: { threadId: input.threadId, role: "assistant", content: `Answer ${n}.` } });
      return { runId: `p14-run-${n}`, assistantText: `Answer ${n}.` };
    },
    threadBusy: async () => null,
    roleOf: async () => "editor",
    requeue: async () => undefined,
    post: async (_conn, channel, threadTs, text) => void posts.push({ channel, threadTs, text }),
    appUrl: () => "https://app.example.com",
    now: () => new Date(),
    notifyHeld: async (i) => void held.push(i),
  };
  let installationId = "";
  const mention = (ts: string, text = "draft the launch post"): SlackMentionJobPayload => ({
    workspaceId: WS_A,
    installationId,
    eventId: `Ev${ts.replace(".", "")}`,
    teamId: TEAM,
    eventType: "app_mention",
    channel: "C0CHAN002",
    user: "U0USER01",
    ts,
    threadTs: ts,
    text,
  });
  const setRule = (agentKey: string, action: string, behavior: "auto" | "ask" | "never") =>
    withWorkspaceScope(WS_A, (tx) =>
      tx.automationSetting.upsert({
        where: { workspaceId_agentKey_action: { workspaceId: WS_A, agentKey, action } },
        create: { workspaceId: WS_A, agentKey, action, behavior, updatedBy: USER },
        update: { behavior },
      }),
    );
  const clearRules = () => withWorkspaceScope(WS_A, (tx) => tx.automationSetting.deleteMany({ where: { workspaceId: WS_A } }));

  before(async () => {
    installationId = (await routeSlackTeam(TEAM))!.id;
    await withWorkspaceScope(WS_A, (tx) => tx.slackInstallation.updateMany({ where: { teamId: TEAM }, data: { enabled: true } }));
    // The earlier suite removed the installer; Slack tasks run as a current member.
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: WS_A, userId: USER } });
    await prisma.workspaceMember.create({ data: { workspaceId: WS_A, userId: USER, role: "editor", email: `${RUN}@example.com` } });
  });
  after(clearRules);

  it("default (no rule): the reply is posted at once — today's behaviour", async () => {
    await clearRules();
    const before = posts.length;
    const out = await runSlackMention(mention("1760001000.000100"), deps);
    assert.equal(out.status === "answered" && out.reply, "posted");
    assert.equal(posts.length, before + 1);
    assert.equal(posts.at(-1)!.text, `Answer ${n}.`);
  });

  it("slack_reply = ask: nothing is posted; the reply waits as a pending connector call; approvers are told", async () => {
    await clearRules();
    await setRule("*", "slack_reply", "ask");
    const before = posts.length;
    const out = await runSlackMention(mention("1760001100.000100"), deps);
    assert.equal(out.status, "answered");
    if (out.status !== "answered") return;
    assert.equal(out.reply, "held");
    assert.equal(posts.length, before, "nothing posted to Slack");
    assert.equal(held.length, 1);
    assert.match(held[0]!.title, /Slack reply waiting for your OK: Answer/);
    assert.match(held[0]!.href, /^\/dashboard\/assistant\?project=/);

    const last = await prisma.aiChatMessage.findFirst({ where: { threadId: out.chatThreadId, role: "assistant" }, orderBy: { createdAt: "desc" } });
    const calls = last!.toolCalls as unknown as ChatToolCall[];
    const call = calls.find((c) => c.tool === SLACK_REPLY_TOOL);
    assert.equal(call?.status, "pending_confirmation");
    assert.deepEqual(call?.args, { channel: "C0CHAN002", threadTs: "1760001100.000100", text: `Answer ${n}.` });
    assert.equal(call?.autoAction, "slack_reply", "the chat offers 'do this without asking'");
    assert.match(last!.content, /nothing has been posted yet/);

    // Approve: "yes" in the chat posts it through the connector gate (the
    // Slack installation is this project's Slack binding).
    const yes = await runAgentTurn({ projectId, workspaceId: WS_A, userId: USER, role: "editor", threadId: out.chatThreadId, userContent: "yes" });
    const ran = yes.toolCalls.find((c) => c.tool === SLACK_REPLY_TOOL);
    assert.equal(ran?.status, "executed", ran?.resultSummary);
    // No bot token in this test: the adapter's labelled MOCK answered (the
    // live chat.postMessage is UNVERIFIED-LIVE here; its request shape is
    // covered by the Slack adapter's unit tests).
    assert.match(ran!.resultSummary ?? "", /connector\.slack\.reply_in_thread/);
    const audit = await prisma.fileChangeLog.findFirst({
      where: { workspaceId: WS_A, summary: { contains: "connector.slack.reply_in_thread" }, action: "ai_applied" },
    });
    assert.ok(audit, "the post is audited as applied after the person's OK");
    // Nothing is waiting any more.
    const { pendingProposal } = await import("@/lib/chat/agent");
    assert.equal(await pendingProposal(out.chatThreadId), null);
  });

  it("status and error lines follow the same rule (held, not posted)", async () => {
    await clearRules();
    await setRule("*", "slack_reply", "ask");
    const before = posts.length;
    const busyDeps: MentionDeps = { ...deps, threadBusy: async () => "a run is still working in this thread" };
    // A first mention maps the thread; then a busy thread gives up at the cap.
    const first = await runSlackMention(mention("1760001200.000100"), deps);
    assert.equal(first.status === "answered" && first.reply, "held");
    const out = await runSlackMention({ ...mention("1760001200.000100"), eventId: "EvGiveUp", deferrals: 20 }, busyDeps);
    assert.equal(out.status, "skipped");
    assert.equal(posts.length, before, "the give-up line was not posted");
    if (first.status !== "answered") return;
    const last = await prisma.aiChatMessage.findFirst({ where: { threadId: first.chatThreadId, role: "assistant" }, orderBy: { createdAt: "desc" } });
    const texts = (last!.toolCalls as unknown as ChatToolCall[]).filter((c) => c.tool === SLACK_REPLY_TOOL).map((c) => String(c.args.text));
    assert.ok(texts.some((t) => /couldn't start this/.test(t)), "the status line joined the pending reply");
  });

  it("slack_placeholder on: only the one-line note is posted while the reply waits", async () => {
    await clearRules();
    await setRule("*", "slack_reply", "ask");
    await setRule("*", "slack_placeholder", "auto");
    const before = posts.length;
    const out = await runSlackMention(mention("1760001300.000100"), deps);
    assert.equal(out.status === "answered" && out.reply, "held");
    assert.equal(posts.length, before + 1);
    assert.equal(posts.at(-1)!.text, SLACK_PLACEHOLDER_TEXT);
  });

  it("an agent's own auto rule wins (posted at once); Off posts and holds nothing", async () => {
    await clearRules();
    await setRule("*", "slack_reply", "ask");
    await setRule("lead", "slack_reply", "auto");
    let before = posts.length;
    const out = await runSlackMention(mention("1760001400.000100"), deps);
    assert.equal(out.status === "answered" && out.reply, "posted");
    assert.equal(posts.length, before + 1);

    await clearRules();
    await setRule("*", "slack_reply", "never");
    before = posts.length;
    const off = await runSlackMention(mention("1760001500.000100"), deps);
    assert.equal(off.status === "answered" && off.reply, "off");
    assert.equal(posts.length, before);
    if (off.status !== "answered") return;
    const last = await prisma.aiChatMessage.findFirst({ where: { threadId: off.chatThreadId, role: "assistant" }, orderBy: { createdAt: "desc" } });
    assert.ok(!(Array.isArray(last?.toolCalls) && (last!.toolCalls as unknown as ChatToolCall[]).some((c) => c.tool === SLACK_REPLY_TOOL)));
  });
});

// ---------------------------------------------------------------------------
// Phase 14 (approvals): connector writes have their own switch.
// ---------------------------------------------------------------------------

import { resolveConnectorTool } from "@/lib/chat/connector-tools";
import type { ToolContext } from "@/lib/chat/tools";

describe("Phase 14: a connector write runs under its write_<key> rule; a money connector's never", () => {
  const ctx = (): ToolContext =>
    ({ projectId, workspaceId: WS_A, userId: USER, role: "editor", agentKey: "lead", grant: null, confirmed: false }) as unknown as ToolContext;
  const setRule = (action: string, behavior: "auto" | "ask") =>
    withWorkspaceScope(WS_A, (tx) =>
      tx.automationSetting.upsert({
        where: { workspaceId_agentKey_action: { workspaceId: WS_A, agentKey: "lead", action } },
        create: { workspaceId: WS_A, agentKey: "lead", action, behavior, updatedBy: USER },
        update: { behavior },
      }),
    );
  after(() => withWorkspaceScope(WS_A, (tx) => tx.automationSetting.deleteMany({ where: { workspaceId: WS_A } })));

  it("slack.post_message: asks (offering write_slack) without a rule, runs without a prompt under one", async () => {
    await withWorkspaceScope(WS_A, (tx) => tx.automationSetting.deleteMany({ where: { workspaceId: WS_A } }));
    const asked = await resolveConnectorTool("connector.slack.post_message", ctx(), { channel: "C0CHAN001", text: "hi" });
    assert.equal(asked.status, "pending_confirmation", asked.resultSummary);
    assert.equal(asked.autoAction, "write_slack");
    await setRule("write_slack", "auto");
    const ran = await resolveConnectorTool("connector.slack.post_message", ctx(), { channel: "C0CHAN001", text: "hi" });
    assert.equal(ran.status, "executed", ran.resultSummary);
    const audit = await prisma.fileChangeLog.findFirst({
      where: { workspaceId: WS_A, action: "ai_applied", summary: { contains: "auto-approved by the write_slack rule for agent lead" } },
    });
    assert.ok(audit, "the auto-approval is audited, naming the rule");
  });

  it("quickbooks.post_to_quickbooks (Tier 3) still asks with forced auto rows, and is never offered", async () => {
    const qb = await prisma.connectorConnection.create({ data: { connectorKey: "quickbooks", workspaceId: WS_A, userId: USER, status: "active", scopes: [] } });
    await prisma.projectDataSource.create({ data: { projectId, connectionId: qb.id, connectorKey: "quickbooks" } });
    await setRule("post_to_accounting", "auto");
    await setRule("money_connector_write", "auto");
    const out = await resolveConnectorTool("connector.quickbooks.post_to_quickbooks", ctx(), {});
    assert.equal(out.status, "pending_confirmation", out.resultSummary);
    assert.equal(out.autoAction, undefined);
  });
});
