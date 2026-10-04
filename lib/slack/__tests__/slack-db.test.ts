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
