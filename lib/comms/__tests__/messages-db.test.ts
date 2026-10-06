// ShapesOS — Phase 18.2 (WS=comms) DB test: Messages.
//   - channel membership and DM privacy: public and project channels are
//     open to every member; a private channel or DM answers 404 to anyone
//     outside it (reads AND posts); one DM per set of people; FORCE RLS keeps
//     another workspace out; unread counts follow the read mark;
//   - mentions notify only people who can see the message (never a
//     non-member of a private channel); a DM notifies the other person once;
//     under focus the notice is held;
//   - presence: heartbeat → active; old → away; focus wins; strangers are
//     never answered;
//   - an @agent mention → a queued channel_agent job → a tracked turn in a
//     mapped chat thread → the agent's reply in the thread with its proposal
//     inline; a viewer can't decide; Approve sends the chat's "yes" through
//     executeTool (the reminder is created), Discard drops the proposal, a
//     follow-up in the same thread continues the same chat thread, a
//     viewer's mention starts nothing.
// Real Postgres as the least-privilege app role; the agent's model turn is a
// stub that proposes through the REAL executeTool gate.
// Run: DATABASE_URL=<app role> npx tsx --test lib/comms/__tests__/messages-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "@/lib/chat/tools";
import type { ChatToolCall } from "@/lib/chat/tool-exec";
import type { MessagesCtx } from "../messages/store.server";
import type { ChannelAgentDeps, ChannelAgentJobPayload } from "../messages/agent.server";

const RUN = randomUUID().slice(0, 8);
const WS = `p182-msg-${RUN}`;
const WS_B = `p182-msg-b-${RUN}`;
const ANA = `p182-msg-ana-${RUN}`; // owner
const BEN = `p182-msg-ben-${RUN}`; // editor
const VI = `p182-msg-vi-${RUN}`; // viewer
const ZED = `p182-msg-zed-${RUN}`; // another workspace

let prisma: typeof import("@/lib/prisma").prisma;
let rls: typeof import("@/lib/substrate/memory/rls");
let store: typeof import("../messages/store.server");
let agent: typeof import("../messages/agent.server");
type Tx = import("@prisma/client").Prisma.TransactionClient;
const inWs = <T,>(ws: string, fn: (tx: Tx) => Promise<T>) => rls.withWorkspaceScope(ws, (tx) => fn(tx as Tx));

const ctx = (userId: string, role: MessagesCtx["role"], name: string, ws = WS): MessagesCtx => ({ workspaceId: ws, userId, role, name, email: `${name.toLowerCase()}-${RUN}@example.com` });
const anaC = () => ctx(ANA, "owner", "Ana");
const benC = () => ctx(BEN, "editor", "Ben");
const viC = () => ctx(VI, "viewer", "Vi");

const ids: Record<string, string> = {};
const started: ChannelAgentJobPayload[] = [];
const captureDeps = () => ({ ...store.defaultPostDeps(), startAgent: async (p: ChannelAgentJobPayload) => void started.push(p) });

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  rls = await import("@/lib/substrate/memory/rls");
  store = await import("../messages/store.server");
  agent = await import("../messages/agent.server");
  for (const ws of [WS, WS_B]) await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ws === WS ? ANA : ZED } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "owner", name: "Ana", email: `ana-${RUN}@example.com` },
      { workspaceId: WS, userId: BEN, role: "editor", name: "Ben", email: `ben-${RUN}@example.com` },
      { workspaceId: WS, userId: VI, role: "viewer", name: "Vi", email: `vi-${RUN}@example.com` },
      { workspaceId: WS_B, userId: ZED, role: "owner", name: "Zed", email: `zed-${RUN}@example.com` },
    ],
  });
  ids.project = (await prisma.project.create({ data: { workspaceId: WS, domain: `msg-${RUN}.example` } })).id;
});

after(async () => {
  await prisma.userDeskState.deleteMany({ where: { userId: { in: [ANA, BEN, VI, ZED] } } }).catch(() => undefined);
  await prisma.notification.deleteMany({ where: { workspaceId: { in: [WS, WS_B] } } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_B] } } });
  await prisma.$disconnect();
});

describe("channel membership and DM privacy", () => {
  it("public and project channels are open; private channels and DMs answer 404 outside", async () => {
    const general = await store.createChannel(anaC(), { name: "General chat" });
    assert.equal(general.name, "general-chat");
    ids.general = general.id;
    const secret = await store.createChannel(anaC(), { name: "secret", isPrivate: true, members: [`user:${BEN}`] });
    ids.secret = secret.id;
    assert.equal(await status(store.createChannel(benC(), { name: "General  Chat!" })), 409, "names are unique");

    const viList = await store.listChannels(viC());
    assert.ok(viList.some((c) => c.id === general.id && !c.joined), "a public channel is listed (not joined)");
    assert.ok(viList.some((c) => c.kind === "project" && c.projectId === ids.project), "the project's channel is created and listed");
    assert.ok(!viList.some((c) => c.id === secret.id), "a private channel is not listed outside");
    assert.equal(await status(store.listMessages(viC(), secret.id)), 404);
    assert.equal(await status(store.postMessage(viC(), secret.id, { body: "hello?" }, captureDeps())), 404);
    assert.equal(await status(store.joinChannel(viC(), secret.id)), 404, "can't join what you can't see");
    assert.ok((await store.listChannels(benC())).some((c) => c.id === secret.id && c.joined));

    const dm = await store.openDm(anaC(), { members: [`user:${BEN}`] });
    ids.dm = dm.id;
    assert.equal(dm.kind, "dm");
    assert.equal(dm.name, "Ben");
    assert.equal((await store.openDm(benC(), { members: [`user:${ANA}`] })).id, dm.id, "one DM per set of people");
    assert.notEqual((await store.openDm(anaC(), { members: [`user:${BEN}`, `user:${VI}`] })).id, dm.id, "a different set is a different DM");
    assert.equal(await status(store.listMessages(viC(), dm.id)), 404, "a DM is private to its members");
    assert.equal(await status(store.openDm(anaC(), { members: [`user:${ZED}`] })), 400, "never someone from another workspace");
    assert.equal(await status(store.leaveChannel(anaC(), dm.id)), 400);

    // FORCE RLS: another workspace's scope sees none of it.
    assert.equal(await inWs(WS_B, (tx) => tx.chatChannel.count({ where: { id: { in: [general.id, secret.id, dm.id] } } })), 0);
    assert.equal((await store.listChannels(ctx(ZED, "owner", "Zed", WS_B))).length, 0);

    // Posting in a public channel joins it; unread counts follow the read mark.
    await store.postMessage(viC(), general.id, { body: "hi all" }, captureDeps());
    assert.ok((await store.listChannels(viC())).find((c) => c.id === general.id)?.joined);
    await store.postMessage(benC(), secret.id, { body: "first" }, captureDeps());
    await store.postMessage(benC(), secret.id, { body: "second, @Ana" }, captureDeps());
    const anaSecret = (await store.listChannels(anaC())).find((c) => c.id === secret.id)!;
    assert.equal(anaSecret.unread, 2);
    assert.equal(anaSecret.mentioned, true);
    assert.ok((await store.unreadSummary(anaC())).total >= 2);
    await store.markRead(anaC(), secret.id);
    assert.equal((await store.listChannels(anaC())).find((c) => c.id === secret.id)!.unread, 0);
    assert.equal((await store.listChannels(benC())).find((c) => c.id === secret.id)!.unread, 0, "your own messages are never unread");

    // Threads: a reply to a reply joins the root's thread; the root counts it.
    const root = await store.postMessage(anaC(), general.id, { body: "thread root" }, captureDeps());
    const r1 = await store.postMessage(benC(), general.id, { body: "reply 1", parentId: root.message.id }, captureDeps());
    const r2 = await store.postMessage(anaC(), general.id, { body: "reply 2", parentId: r1.message.id }, captureDeps());
    assert.equal(r2.message.parentId, root.message.id);
    const top = await store.listMessages(viC(), general.id);
    assert.equal(top.messages.find((m) => m.id === root.message.id)?.replyCount, 2);
    assert.ok(!top.messages.some((m) => m.id === r1.message.id), "replies stay in the thread");
    const th = await store.listMessages(viC(), general.id, { thread: root.message.id });
    assert.deepEqual(th.messages.map((m) => m.body), ["thread root", "reply 1", "reply 2"]);

    // Edit / remove: your own; an admin may remove; the stream sees both.
    const since = new Date(Date.now() - 1000);
    assert.equal(await status(store.editMessage(viC(), root.message.id, "nope")), 403);
    await store.editMessage(anaC(), root.message.id, "thread root (edited)");
    await store.removeMessage(anaC(), r1.message.id);
    const ch = await store.changesSince(viC(), general.id, since);
    assert.ok(ch.messages.some((m) => m.id === root.message.id && m.body === "thread root (edited)" && m.editedAt));
    assert.ok(ch.messages.some((m) => m.id === r1.message.id && m.removed && m.body === ""));
    assert.equal(await status(store.changesSince(viC(), secret.id, since)), 404, "the stream checks visibility on every poll");

    // The project's chat keeps working as a channel of the Messages app.
    const project = (await store.listChannels(benC())).find((c) => c.projectId === ids.project)!;
    await store.postMessage(benC(), project.id, { body: "project hello" }, captureDeps());
    assert.equal((await store.listMessages(anaC(), project.id)).messages.at(-1)?.body, "project hello");
  });
});

describe("mentions and DMs notify through the producers", () => {
  it("only people who can see it; a DM once; held under focus", async () => {
    const count = (userId: string, kind: "mention" | "direct_message") => prisma.notification.count({ where: { workspaceId: WS, userId, kind } });
    const viBefore = await count(VI, "mention");
    await store.postMessage(benC(), ids.secret!, { body: "@Vi can you see this?" }, store.defaultPostDeps());
    assert.equal(await count(VI, "mention"), viBefore, "a non-member of a private channel is never told");

    const out = await store.postMessage(anaC(), ids.general!, { body: "@Ben please review" }, store.defaultPostDeps());
    assert.deepEqual(out.message.mentions, [`user:${BEN}`]);
    const n = await prisma.notification.findFirst({ where: { workspaceId: WS, userId: BEN, kind: "mention", sourceId: out.message.id } });
    assert.ok(n, "Ben is told");
    assert.match(n!.href ?? "", new RegExp(`/dashboard/messages\\?c=${ids.general}`));

    const dmBefore = await count(BEN, "direct_message");
    const mBefore = await count(BEN, "mention");
    await store.postMessage(anaC(), ids.dm!, { body: "@Ben quick question" }, store.defaultPostDeps());
    assert.equal(await count(BEN, "direct_message"), dmBefore + 1, "the other person in the DM");
    assert.equal(await count(BEN, "mention"), mBefore, "no second notice for a mention inside the DM");
    assert.equal(await count(ANA, "direct_message"), 0, "never the author");

    const { startFocus, endFocus } = await import("@/lib/desktop/focus.server");
    await startFocus(BEN, { minutes: 30 });
    const held = await store.postMessage(anaC(), ids.dm!, { body: "while you focus" }, store.defaultPostDeps());
    const row = await prisma.notification.findFirst({ where: { userId: BEN, kind: "direct_message", sourceId: held.message.id } });
    assert.ok(row?.heldAt, "held while Ben is in focus");
    await endFocus(BEN);
  });
});

describe("presence", () => {
  it("heartbeat, away, focus; members of this workspace only", async () => {
    await store.heartbeat(anaC());
    let p = await store.presenceFor(benC(), [ANA, ZED, VI]);
    assert.deepEqual(p.map((x) => x.userId).sort(), [ANA, VI].sort(), "never a stranger");
    assert.equal(p.find((x) => x.userId === ANA)?.status, "active");
    assert.equal(p.find((x) => x.userId === VI)?.status, "offline");
    await inWs(WS, (tx) => tx.userPresence.updateMany({ where: { workspaceId: WS, userId: ANA }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } }));
    p = await store.presenceFor(benC(), [ANA]);
    assert.equal(p[0]?.status, "away");
    const { startFocus, endFocus } = await import("@/lib/desktop/focus.server");
    await startFocus(ANA, { minutes: 15 });
    assert.equal((await store.presenceFor(benC(), [ANA]))[0]?.status, "focus");
    await endFocus(ANA);
    assert.equal(await inWs(WS_B, (tx) => tx.userPresence.count({ where: { userId: ANA } })), 0, "FORCE RLS");
  });
});

describe("an agent mentioned in a channel", () => {
  // The model turn is a stub; what it proposes goes through the REAL executeTool gate.
  const turnCalls: { userContent: string; threadId: string; userId: string }[] = [];
  const deps = (): ChannelAgentDeps => ({
    ...agent.defaultChannelAgentDeps,
    threadBusy: async () => null,
    isMock: async () => true,
    requeue: async () => undefined,
    runTurn: async (input) => {
      turnCalls.push({ userContent: input.userContent, threadId: input.threadId, userId: input.userId });
      const { executeTool } = await import("@/lib/chat/tool-exec");
      const tctx = (confirmed: boolean): ToolContext => ({ projectId: input.projectId, workspaceId: input.workspaceId, userId: input.userId, role: input.role, confirmed, agentKey: "researcher", grant: ["workspace", "calendar"] });
      if (input.userContent === "yes") {
        const { pendingProposal } = await import("@/lib/chat/agent");
        const pending = (await pendingProposal(input.threadId)) ?? [];
        const done: ChatToolCall[] = [];
        for (const c of pending) {
          const call: ChatToolCall = { ...c, status: "pending_confirmation" };
          await executeTool(tctx(true), c.tool, c.args, call);
          done.push(call);
        }
        await prisma.aiChatMessage.create({ data: { threadId: input.threadId, role: "assistant", content: "Done.", toolCalls: done as unknown as object } });
        return { runId: `stub-run-yes-${RUN}`, assistantText: done.every((c) => c.status === "executed") ? "Done: the reminder is set." : `Not run: ${done.map((c) => c.resultSummary).join("; ")}` };
      }
      const args = { title: `Send the deck ${RUN}`, dueAt: new Date(Date.now() + 86_400_000).toISOString() };
      const call: ChatToolCall = { tool: "create_reminder", args, status: "pending_confirmation" };
      await executeTool(tctx(false), "create_reminder", args, call);
      await prisma.aiChatMessage.create({ data: { threadId: input.threadId, role: "assistant", content: "I can set that reminder.", toolCalls: [call] as unknown as object } });
      return { runId: `stub-run-${RUN}-${turnCalls.length}`, assistantText: "I can set that reminder. It needs your OK.", awaitingConfirmation: call.status === "pending_confirmation" };
    },
  });

  it("mention → queued job → tracked turn → the reply with its proposal inline → approve runs it as the decider", async () => {
    started.length = 0;
    const posted = await store.postMessage(benC(), ids.general!, { body: "@Researcher remind me to send the deck tomorrow" }, { ...store.defaultPostDeps(), startAgent: async (p) => void started.push(p) });
    assert.deepEqual(posted.agents, ["researcher"]);
    assert.equal(started.length, 1);
    assert.deepEqual(started[0], { workspaceId: WS, channelId: ids.general, messageId: posted.message.id, agentKey: "researcher", requestedBy: BEN, mode: "turn" });
    const members = await store.channelMembers(benC(), ids.general!);
    assert.ok(members.some((m) => m.key === "agent:researcher"), "a mentioned agent becomes a member");

    // The real queue path: enqueueChannelAgent writes a channel_agent job.
    await agent.enqueueChannelAgent(started[0]!);
    assert.equal(await inWs(WS, (tx) => tx.agentJob.count({ where: { workspaceId: WS, kind: "channel_agent" } })), 1);

    const out = await agent.runChannelAgent(started[0]!, deps());
    assert.equal(out.status, "answered");
    if (out.status !== "answered") return;
    assert.equal(out.awaiting, true);
    assert.match(turnCalls[0]!.userContent, /^Message from Ben in #general-chat/);
    assert.equal(turnCalls[0]!.userId, BEN, "the turn runs as the person who asked");
    const reply = (await store.listMessages(benC(), ids.general!, { thread: posted.message.id })).messages.find((m) => m.id === out.messageId)!;
    assert.equal(reply.authorKind, "agent");
    assert.equal(reply.agentKey, "researcher");
    assert.equal(reply.parentId, posted.message.id, "the answer lands in the thread");
    assert.equal(reply.meta?.awaiting, true);
    assert.equal(reply.meta?.proposals[0]?.tool, "create_reminder");
    assert.equal(reply.meta?.proposals[0]?.autoAction, "create_reminder");
    assert.equal(reply.meta?.mock, true, "labelled mock without a live model");
    assert.ok(await prisma.notification.findFirst({ where: { userId: BEN, kind: "mention", sourceId: reply.id } }), "Ben is told the agent answered");
    assert.equal(await inWs(WS, (tx) => tx.opsTask.count({ where: { workspaceId: WS, assigneeId: BEN } })), 0, "nothing ran yet");

    assert.equal(await status(agent.decideProposal(viC(), reply.id, "approve")), 403, "a viewer can't decide");
    const captured: ChannelAgentJobPayload[] = [];
    const decideDeps = { enqueue: async (p: ChannelAgentJobPayload) => void captured.push(p), drop: agent.defaultDecideDeps.drop };
    const meta = await agent.decideProposal(benC(), reply.id, "approve", decideDeps);
    assert.equal(meta.decision?.status, "running");
    assert.equal(await status(agent.decideProposal(benC(), reply.id, "approve", decideDeps)), 409, "decided once");
    assert.deepEqual(captured[0], { workspaceId: WS, channelId: ids.general, messageId: reply.id, agentKey: "researcher", requestedBy: BEN, mode: "confirm" });

    const confirmed = await agent.runChannelAgent(captured[0]!, deps());
    assert.equal(confirmed.status, "answered");
    assert.equal(turnCalls.at(-1)!.userContent, "yes", "the chat's own confirmation");
    const reminders = await inWs(WS, (tx) => tx.opsTask.findMany({ where: { workspaceId: WS, assigneeId: BEN, projectId: null } }));
    assert.equal(reminders.length, 1, "executeTool ran the proposal");
    assert.equal(reminders[0]!.title, `Send the deck ${RUN}`);
    const thread = (await store.listMessages(anaC(), ids.general!, { thread: posted.message.id })).messages;
    assert.equal(thread.find((m) => m.id === reply.id)?.meta?.decision?.status, "done");
    assert.ok(thread.some((m) => m.meta?.resolves === reply.id && /reminder is set/.test(m.body)), "the result is posted in the thread");
  });

  it("discard drops the proposal; a follow-up continues the same chat thread; a viewer starts nothing", async () => {
    const posted = await store.postMessage(benC(), ids.general!, { body: "@researcher another reminder please" }, { ...store.defaultPostDeps(), startAgent: async () => undefined });
    const payload: ChannelAgentJobPayload = { workspaceId: WS, channelId: ids.general!, messageId: posted.message.id, agentKey: "researcher", requestedBy: BEN, mode: "turn" };
    const first = await agent.runChannelAgent(payload, deps());
    assert.equal(first.status, "answered");
    if (first.status !== "answered") return;
    await agent.decideProposal(benC(), first.messageId, "discard");
    const { pendingProposal } = await import("@/lib/chat/agent");
    assert.equal(await pendingProposal(first.chatThreadId), null, "nothing waits for a yes any more");
    const after = (await store.listMessages(benC(), ids.general!, { thread: posted.message.id })).messages.find((m) => m.id === first.messageId);
    assert.equal(after?.meta?.decision?.decision, "discard");

    const follow = await store.postMessage(benC(), ids.general!, { body: "@Researcher actually make it Friday", parentId: posted.message.id }, { ...store.defaultPostDeps(), startAgent: async () => undefined });
    const second = await agent.runChannelAgent({ ...payload, messageId: follow.message.id }, deps());
    assert.equal(second.status, "answered");
    if (second.status === "answered") assert.equal(second.chatThreadId, first.chatThreadId, "the thread maps to one chat thread");
    assert.match(turnCalls.at(-1)!.userContent, /Earlier in this thread:/);

    const viPost = await store.postMessage(viC(), ids.general!, { body: "@Researcher hello" }, { ...store.defaultPostDeps(), startAgent: async () => assert.fail("a viewer's mention must not start an agent") });
    assert.equal(viPost.agentsSkipped, "viewer");
    assert.deepEqual(viPost.agents, []);
    // And a stale job for a viewer is refused by the job itself.
    const refused = await agent.runChannelAgent({ ...payload, messageId: viPost.message.id, requestedBy: VI }, deps());
    assert.equal(refused.status, "skipped");

    // A one-to-one DM with an agent: every message goes to it.
    const dm = await store.openDm(benC(), { members: ["agent:planner"] });
    const dmPost = await store.postMessage(benC(), dm.id, { body: "plan my week" }, { ...store.defaultPostDeps(), startAgent: async () => undefined });
    assert.deepEqual(dmPost.agents, ["planner"]);
  });
});
