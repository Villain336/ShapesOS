// ShapesOS — Phase 18.2 (WS=comms): Messages — channels, DMs, threads,
// membership, read state, presence. Every read and write runs inside
// withWorkspaceScope (chat tables are FORCE RLS on the workspace).
//
// Who sees what:
//   project channel   every member of the workspace (projects are workspace-
//                     wide); reading or posting makes you a member (read state)
//   public channel    every member can read and join; posting joins
//   private channel   members only — anyone else gets 404 (never "forbidden":
//                     the channel's existence is not leaked)
//   DM                its members only, same 404
//
// A mention notifies only people who can see the message (a mention of a
// non-member in a private channel or DM notifies nobody). Agents are
// members too: mentioning one adds it, and starts it (lib/comms/messages/
// agent.server.ts) for editors and above.

import { Prisma, type WorkspaceRole } from "@prisma/client";
import { HttpError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { roleAtLeast } from "@/lib/authz";
import { LEAD_AGENT, SUB_AGENTS } from "@/lib/aos/agents";
import {
  agentMemberKey,
  buildMentionTargets,
  channelName,
  dmKeyFor,
  MAX_AGENTS_PER_MESSAGE,
  MAX_MESSAGE_CHARS,
  parseMemberKey,
  parseMentions,
  presenceStatus,
  STREAM_OVERLAP_MS,
  userKey,
  type MemberKey,
  type MentionTarget,
  type PresenceStatus,
} from "./model";

type Tx = Prisma.TransactionClient;

export interface MessagesCtx {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  name: string | null;
  email: string | null;
}

const scoped = <T>(ctx: { workspaceId: string }, fn: (tx: Tx) => Promise<T>) => withWorkspaceScope(ctx.workspaceId, (tx) => fn(tx as Tx));

export function workspaceAgents(): { key: string; name: string }[] {
  return [{ key: "lead", name: LEAD_AGENT.name }, ...Object.entries(SUB_AGENTS).map(([key, p]) => ({ key, name: p.name }))];
}

export function agentName(key: string | null | undefined): string {
  return workspaceAgents().find((a) => a.key === key)?.name ?? "Agent";
}

export async function workspaceMembers(workspaceId: string): Promise<{ userId: string; name: string | null; email: string | null; role: WorkspaceRole }[]> {
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId, userId: { not: null } },
    select: { userId: true, name: true, email: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ userId: r.userId!, name: r.name, email: r.email, role: r.role }));
}

export async function mentionTargets(workspaceId: string): Promise<MentionTarget[]> {
  return buildMentionTargets(await workspaceMembers(workspaceId), workspaceAgents());
}

export function authorNameOf(ctx: MessagesCtx): string {
  return (ctx.name ?? "").trim() || (ctx.email ? ctx.email.split("@")[0]! : "Member");
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

type ChannelRow = Prisma.ChatChannelGetPayload<{ select: typeof CHANNEL_SELECT }>;
const CHANNEL_SELECT = {
  id: true,
  workspaceId: true,
  kind: true,
  projectId: true,
  name: true,
  topic: true,
  isPrivate: true,
  dmKey: true,
  createdBy: true,
  archivedAt: true,
  lastMessageAt: true,
  createdAt: true,
} satisfies Prisma.ChatChannelSelect;

export interface ChannelMemberView {
  key: string;
  kind: "user" | "agent";
  userId: string | null;
  agentKey: string | null;
  label: string;
  role: string;
}

export interface ChannelView {
  id: string;
  kind: "project" | "channel" | "dm";
  name: string;
  topic: string | null;
  isPrivate: boolean;
  projectId: string | null;
  archived: boolean;
  joined: boolean;
  /** owner | member | null (not joined) */
  myRole: string | null;
  memberCount: number;
  unread: number;
  mentioned: boolean;
  lastMessageAt: string;
  /** DMs: the other members (agents included). */
  dmWith: ChannelMemberView[] | null;
}

/** The visibility rule for one channel (see the header). */
export function canSee(channel: Pick<ChannelRow, "kind" | "isPrivate">, isMember: boolean): boolean {
  if (channel.kind === "project") return true;
  if (channel.kind === "channel" && !channel.isPrivate) return true;
  return isMember;
}

/** The channel if this member may see it, else 404 (never a 403 that leaks it exists). */
export async function channelFor(tx: Tx, ctx: MessagesCtx, channelId: string) {
  const channel = await tx.chatChannel.findFirst({ where: { id: channelId, workspaceId: ctx.workspaceId }, select: CHANNEL_SELECT });
  if (!channel) throw new HttpError(404, "Channel not found.");
  const me = await tx.chatChannelMember.findUnique({ where: { channelId_memberKey: { channelId, memberKey: userKey(ctx.userId) } } });
  if (!canSee(channel, !!me)) throw new HttpError(404, "Channel not found.");
  return { channel, me };
}

async function ensureProjectChannels(tx: Tx, workspaceId: string): Promise<void> {
  const projects = await tx.project.findMany({ where: { workspaceId }, select: { id: true, domain: true } });
  if (!projects.length) return;
  const have = new Set(
    (await tx.chatChannel.findMany({ where: { workspaceId, projectId: { in: projects.map((p) => p.id) } }, select: { projectId: true } })).map((c) => c.projectId),
  );
  const missing = projects.filter((p) => !have.has(p.id));
  if (missing.length) {
    await tx.chatChannel.createMany({
      data: missing.map((p) => ({ workspaceId, kind: "project" as const, projectId: p.id, name: `${p.domain} chat` })),
      skipDuplicates: true,
    });
  }
}

function memberLabel(m: { userId: string | null; agentKey: string | null }, people: Map<string, { name: string | null; email: string | null }>): string {
  if (m.agentKey) return agentName(m.agentKey);
  const p = m.userId ? people.get(m.userId) : null;
  return (p?.name ?? "").trim() || (p?.email ? p.email.split("@")[0]! : "Former member");
}

/** Unread counts for the member, per channel (messages by others after their read mark). */
async function unreadByChannel(tx: Tx, ctx: MessagesCtx): Promise<Map<string, { n: number; mentioned: boolean }>> {
  const me = userKey(ctx.userId);
  const rows = await tx.$queryRaw<{ channelId: string; n: number; mentioned: boolean }[]>`
    SELECT m."channel_id" AS "channelId", COUNT(*)::int AS "n", BOOL_OR(${me} = ANY(m."mentions")) AS "mentioned"
    FROM "team_chat_messages" m
    JOIN "chat_channel_members" cm ON cm."channel_id" = m."channel_id" AND cm."member_key" = ${me}
    JOIN "chat_channels" c ON c."id" = m."channel_id" AND c."archived_at" IS NULL
    WHERE m."workspace_id" = ${ctx.workspaceId}
      AND m."user_id" <> ${ctx.userId}
      AND m."created_at" > COALESCE(cm."last_read_at", cm."joined_at")
    GROUP BY m."channel_id"`;
  return new Map(rows.map((r) => [r.channelId, { n: Number(r.n), mentioned: !!r.mentioned }]));
}

export async function listChannels(ctx: MessagesCtx, opts: { includeArchived?: boolean } = {}): Promise<ChannelView[]> {
  const me = userKey(ctx.userId);
  return scoped(ctx, async (tx) => {
    await ensureProjectChannels(tx, ctx.workspaceId);
    const rows = await tx.chatChannel.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        ...(opts.includeArchived ? {} : { archivedAt: null }),
        OR: [{ kind: "project" }, { kind: "channel", isPrivate: false }, { members: { some: { memberKey: me } } }],
      },
      select: { ...CHANNEL_SELECT, _count: { select: { members: true } }, members: { where: { memberKey: me }, select: { role: true } } },
      orderBy: [{ lastMessageAt: "desc" }],
      take: 300,
    });
    const dmIds = rows.filter((r) => r.kind === "dm").map((r) => r.id);
    const dmMembers = dmIds.length
      ? await tx.chatChannelMember.findMany({ where: { channelId: { in: dmIds } }, select: { channelId: true, memberKey: true, userId: true, agentKey: true, role: true } })
      : [];
    const people = new Map((await workspaceMembers(ctx.workspaceId)).map((m) => [m.userId, m]));
    const unread = await unreadByChannel(tx, ctx);
    return rows.map((r) => {
      const u = unread.get(r.id);
      const dmWith =
        r.kind === "dm"
          ? dmMembers
              .filter((m) => m.channelId === r.id && m.memberKey !== me)
              .map<ChannelMemberView>((m) => ({ key: m.memberKey, kind: m.agentKey ? "agent" : "user", userId: m.userId, agentKey: m.agentKey, label: memberLabel(m, people), role: m.role }))
          : null;
      return {
        id: r.id,
        kind: r.kind,
        name: r.kind === "dm" ? (dmWith?.map((m) => m.label).join(", ") || "Just you") : r.name,
        topic: r.topic,
        isPrivate: r.isPrivate || r.kind === "dm",
        projectId: r.projectId,
        archived: !!r.archivedAt,
        joined: r.members.length > 0,
        myRole: r.members[0]?.role ?? null,
        memberCount: r._count.members,
        unread: u?.n ?? 0,
        mentioned: u?.mentioned ?? false,
        lastMessageAt: r.lastMessageAt.toISOString(),
        dmWith,
      };
    });
  });
}

export async function channelMembers(ctx: MessagesCtx, channelId: string): Promise<ChannelMemberView[]> {
  return scoped(ctx, async (tx) => {
    await channelFor(tx, ctx, channelId);
    const rows = await tx.chatChannelMember.findMany({ where: { channelId }, orderBy: { joinedAt: "asc" }, take: 500 });
    const people = new Map((await workspaceMembers(ctx.workspaceId)).map((m) => [m.userId, m]));
    return rows.map((m) => ({ key: m.memberKey, kind: m.agentKey ? ("agent" as const) : ("user" as const), userId: m.userId, agentKey: m.agentKey, label: memberLabel(m, people), role: m.role }));
  });
}

/** Validate member keys: workspace members and known agents only. */
async function validMembers(workspaceId: string, keys: readonly string[]): Promise<{ key: MemberKey; userId: string | null; agentKey: string | null }[]> {
  const people = new Set((await workspaceMembers(workspaceId)).map((m) => m.userId));
  const agents = new Set(workspaceAgents().map((a) => a.key));
  const out: { key: MemberKey; userId: string | null; agentKey: string | null }[] = [];
  for (const k of new Set(keys)) {
    const p = parseMemberKey(k);
    if (p?.kind === "user" && people.has(p.id)) out.push({ key: userKey(p.id), userId: p.id, agentKey: null });
    else if (p?.kind === "agent" && agents.has(p.id)) out.push({ key: agentMemberKey(p.id), userId: null, agentKey: p.id });
    else throw new HttpError(400, "One of the people or agents is not in this workspace.");
  }
  return out;
}

export async function createChannel(ctx: MessagesCtx, input: { name: string; topic?: string | null; isPrivate?: boolean; members?: string[] }): Promise<ChannelView> {
  const name = channelName(input.name);
  if (!name) throw new HttpError(400, "Give the channel a name (letters, numbers and dashes).");
  const extra = await validMembers(ctx.workspaceId, (input.members ?? []).filter((k) => k !== userKey(ctx.userId)));
  const id = await scoped(ctx, async (tx) => {
    const clash = await tx.chatChannel.findFirst({ where: { workspaceId: ctx.workspaceId, kind: "channel", name, archivedAt: null }, select: { id: true } });
    if (clash) throw new HttpError(409, `#${name} already exists.`);
    const ch = await tx.chatChannel.create({
      data: { workspaceId: ctx.workspaceId, kind: "channel", name, topic: input.topic?.trim().slice(0, 250) || null, isPrivate: !!input.isPrivate, createdBy: ctx.userId },
      select: { id: true },
    });
    await tx.chatChannelMember.createMany({
      data: [
        { workspaceId: ctx.workspaceId, channelId: ch.id, memberKey: userKey(ctx.userId), userId: ctx.userId, role: "owner", lastReadAt: new Date() },
        ...extra.map((m) => ({ workspaceId: ctx.workspaceId, channelId: ch.id, memberKey: m.key, userId: m.userId, agentKey: m.agentKey })),
      ],
      skipDuplicates: true,
    });
    return ch.id;
  });
  return (await listChannels(ctx)).find((c) => c.id === id)!;
}

/** One DM per set of people (and agents); opening it again returns the same one. */
export async function openDm(ctx: MessagesCtx, input: { members: string[] }): Promise<ChannelView> {
  const others = await validMembers(ctx.workspaceId, input.members.filter((k) => k !== userKey(ctx.userId)));
  if (!others.length) throw new HttpError(400, "Pick at least one person or agent.");
  if (others.length > 8) throw new HttpError(400, "A direct message has at most 9 people. Make a private channel instead.");
  const all = [{ key: userKey(ctx.userId), userId: ctx.userId, agentKey: null as string | null }, ...others];
  const dmKey = dmKeyFor(all.map((m) => m.key));
  const id = await scoped(ctx, async (tx) => {
    const found = await tx.chatChannel.findUnique({ where: { workspaceId_dmKey: { workspaceId: ctx.workspaceId, dmKey } }, select: { id: true } });
    if (found) return found.id;
    const ch = await tx.chatChannel.create({ data: { workspaceId: ctx.workspaceId, kind: "dm", name: "Direct message", dmKey, isPrivate: true, createdBy: ctx.userId }, select: { id: true } });
    await tx.chatChannelMember.createMany({
      data: all.map((m) => ({ workspaceId: ctx.workspaceId, channelId: ch.id, memberKey: m.key, userId: m.userId, agentKey: m.agentKey, lastReadAt: m.userId === ctx.userId ? new Date() : null })),
      skipDuplicates: true,
    });
    return ch.id;
  });
  return (await listChannels(ctx)).find((c) => c.id === id)!;
}

export async function joinChannel(ctx: MessagesCtx, channelId: string): Promise<void> {
  await scoped(ctx, async (tx) => {
    const { channel } = await channelFor(tx, ctx, channelId);
    if (channel.kind === "dm" || (channel.kind === "channel" && channel.isPrivate)) throw new HttpError(400, "Ask a member to add you.");
    if (channel.archivedAt) throw new HttpError(409, "This channel is archived.");
    await tx.chatChannelMember.upsert({
      where: { channelId_memberKey: { channelId, memberKey: userKey(ctx.userId) } },
      create: { workspaceId: ctx.workspaceId, channelId, memberKey: userKey(ctx.userId), userId: ctx.userId, lastReadAt: new Date() },
      update: {},
    });
  });
}

export async function leaveChannel(ctx: MessagesCtx, channelId: string): Promise<void> {
  await scoped(ctx, async (tx) => {
    const { channel, me } = await channelFor(tx, ctx, channelId);
    if (channel.kind === "dm") throw new HttpError(400, "You can't leave a direct message.");
    if (!me) return;
    await tx.chatChannelMember.delete({ where: { id: me.id } });
  });
}

/** Add people / agents to a channel (any member of it may; not DMs — a new set is a new DM). */
export async function addMembers(ctx: MessagesCtx, channelId: string, keys: string[]): Promise<ChannelMemberView[]> {
  const add = await validMembers(ctx.workspaceId, keys);
  await scoped(ctx, async (tx) => {
    const { channel, me } = await channelFor(tx, ctx, channelId);
    if (channel.kind === "dm") throw new HttpError(400, "Start a new direct message to include more people.");
    if (channel.archivedAt) throw new HttpError(409, "This channel is archived.");
    if (!me) throw new HttpError(403, "Join the channel first.");
    await tx.chatChannelMember.createMany({
      data: add.map((m) => ({ workspaceId: ctx.workspaceId, channelId, memberKey: m.key, userId: m.userId, agentKey: m.agentKey })),
      skipDuplicates: true,
    });
  });
  return channelMembers(ctx, channelId);
}

/** Topic / name / archive: the channel's owner or a workspace admin. */
export async function updateChannel(ctx: MessagesCtx, channelId: string, patch: { name?: string; topic?: string | null; archived?: boolean }): Promise<void> {
  await scoped(ctx, async (tx) => {
    const { channel, me } = await channelFor(tx, ctx, channelId);
    if (channel.kind !== "channel") throw new HttpError(400, "Only workspace channels can be renamed or archived.");
    if (me?.role !== "owner" && !roleAtLeast(ctx.role, "admin")) throw new HttpError(403, "Only the channel's owner or an admin can change it.");
    const data: Prisma.ChatChannelUpdateInput = {};
    if (patch.name !== undefined) {
      const name = channelName(patch.name);
      if (!name) throw new HttpError(400, "Give the channel a name (letters, numbers and dashes).");
      const clash = await tx.chatChannel.findFirst({ where: { workspaceId: ctx.workspaceId, kind: "channel", name, archivedAt: null, id: { not: channelId } }, select: { id: true } });
      if (clash) throw new HttpError(409, `#${name} already exists.`);
      data.name = name;
    }
    if (patch.topic !== undefined) data.topic = patch.topic?.trim().slice(0, 250) || null;
    if (patch.archived !== undefined) data.archivedAt = patch.archived ? new Date() : null;
    await tx.chatChannel.update({ where: { id: channelId }, data });
  });
}

/** Mark the channel read up to now (a project channel makes you a member: read state). */
export async function markRead(ctx: MessagesCtx, channelId: string): Promise<void> {
  await scoped(ctx, async (tx) => {
    const { channel, me } = await channelFor(tx, ctx, channelId);
    const now = new Date();
    if (me) await tx.chatChannelMember.update({ where: { id: me.id }, data: { lastReadAt: now } });
    else if (channel.kind === "project")
      await tx.chatChannelMember.create({ data: { workspaceId: ctx.workspaceId, channelId, memberKey: userKey(ctx.userId), userId: ctx.userId, lastReadAt: now } });
  });
}

/** Unread per channel for the member (the stream sends it when it changes). */
export async function unreadMap(ctx: MessagesCtx): Promise<Record<string, { unread: number; mentioned: boolean }>> {
  return scoped(ctx, async (tx) => {
    const out: Record<string, { unread: number; mentioned: boolean }> = {};
    for (const [id, v] of await unreadByChannel(tx, ctx)) out[id] = { unread: v.n, mentioned: v.mentioned };
    return out;
  });
}

/** The dock's count: unread messages across the channels the member is in. */
export async function unreadSummary(ctx: MessagesCtx): Promise<{ total: number; mentions: number; channels: number }> {
  return scoped(ctx, async (tx) => {
    const per = await unreadByChannel(tx, ctx);
    let total = 0;
    let mentions = 0;
    for (const v of per.values()) {
      total += v.n;
      if (v.mentioned) mentions++;
    }
    return { total, mentions, channels: per.size };
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface AgentProposalView {
  tool: string;
  summary: string;
  autoAction: string | null;
}

export interface AgentMeta {
  kind: "agent_reply";
  runId: string | null;
  chatThreadId: string | null;
  projectId: string | null;
  /** The person whose message started it (they, or an admin, decide). */
  requestedBy: string;
  awaiting: boolean;
  proposals: AgentProposalView[];
  decision: { decision: "approve" | "discard"; by: string; byName: string; at: string; status: "running" | "done" | "failed"; note?: string | null } | null;
  /** On a result message: the proposal it answers. */
  resolves?: string | null;
  mock?: boolean;
  failed?: boolean;
}

export interface MessageView {
  id: string;
  channelId: string;
  parentId: string | null;
  userId: string;
  authorName: string;
  authorKind: "user" | "agent" | "system";
  agentKey: string | null;
  body: string;
  mentions: string[];
  meta: AgentMeta | null;
  removed: boolean;
  createdAt: string;
  editedAt: string | null;
  replyCount: number;
  lastReplyAt: string | null;
}

type MessageRow = Prisma.TeamChatMessageGetPayload<object>;

export function asAgentMeta(meta: unknown): AgentMeta | null {
  const m = meta as Partial<AgentMeta> | null;
  return m && typeof m === "object" && m.kind === "agent_reply" ? (m as AgentMeta) : null;
}

export function messageView(m: MessageRow, replies?: { count: number; last: Date | null }): MessageView {
  const removed = (m.meta as { removed?: boolean } | null)?.removed === true;
  return {
    id: m.id,
    channelId: m.channelId,
    parentId: m.parentId,
    userId: m.userId,
    authorName: m.authorName,
    authorKind: (m.authorKind as MessageView["authorKind"]) ?? "user",
    agentKey: m.agentKey,
    body: removed ? "" : m.body,
    mentions: m.mentions,
    meta: removed ? null : asAgentMeta(m.meta),
    removed,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    replyCount: replies?.count ?? 0,
    lastReplyAt: replies?.last ? replies.last.toISOString() : null,
  };
}

async function replyStats(tx: Tx, ids: string[]): Promise<Map<string, { count: number; last: Date | null }>> {
  if (!ids.length) return new Map();
  const rows = await tx.teamChatMessage.groupBy({ by: ["parentId"], where: { parentId: { in: ids } }, _count: { _all: true }, _max: { createdAt: true } });
  return new Map(rows.map((r) => [r.parentId!, { count: r._count._all, last: r._max.createdAt }]));
}

/** A page of the channel (top-level messages, oldest first) or one thread (root + replies). */
export async function listMessages(ctx: MessagesCtx, channelId: string, opts: { before?: Date | null; thread?: string | null; limit?: number } = {}): Promise<{ messages: MessageView[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return scoped(ctx, async (tx) => {
    await channelFor(tx, ctx, channelId);
    if (opts.thread) {
      const root = await tx.teamChatMessage.findFirst({ where: { id: opts.thread, channelId, workspaceId: ctx.workspaceId, parentId: null } });
      if (!root) throw new HttpError(404, "Thread not found.");
      const replies = await tx.teamChatMessage.findMany({ where: { parentId: root.id, workspaceId: ctx.workspaceId }, orderBy: { createdAt: "asc" }, take: 500 });
      const stats = await replyStats(tx, [root.id]);
      return { messages: [messageView(root, stats.get(root.id)), ...replies.map((r) => messageView(r))], hasMore: false };
    }
    const rows = await tx.teamChatMessage.findMany({
      where: { channelId, workspaceId: ctx.workspaceId, parentId: null, ...(opts.before ? { createdAt: { lt: opts.before } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit).reverse();
    const stats = await replyStats(tx, page.map((r) => r.id));
    return { messages: page.map((r) => messageView(r, stats.get(r.id))), hasMore: rows.length > limit };
  });
}

export interface PostOutcome {
  message: MessageView;
  /** Agents this message started. */
  agents: string[];
  /** Why agents were not started (a viewer, too many), if they weren't. */
  agentsSkipped: string | null;
}

export interface PostDeps {
  notifyMention: typeof import("@/lib/notifications/producers").notifyMention;
  notifyDirectMessage: typeof import("@/lib/notifications/producers").notifyDirectMessage;
  startAgent: (payload: import("./agent.server").ChannelAgentJobPayload) => Promise<unknown>;
}

export const defaultPostDeps = (): PostDeps => ({
  notifyMention: async (...a) => (await import("@/lib/notifications/producers")).notifyMention(...a),
  notifyDirectMessage: async (...a) => (await import("@/lib/notifications/producers")).notifyDirectMessage(...a),
  startAgent: async (p) => (await import("./agent.server")).enqueueChannelAgent(p),
});

export function messageHref(channelId: string, threadRootId: string | null): string {
  return `/dashboard/messages?c=${encodeURIComponent(channelId)}${threadRootId ? `&t=${encodeURIComponent(threadRootId)}` : ""}`;
}

export async function postMessage(ctx: MessagesCtx, channelId: string, input: { body: string; parentId?: string | null }, deps: PostDeps = defaultPostDeps()): Promise<PostOutcome> {
  const body = (input.body ?? "").replace(/\s+$/g, "").replace(/^\s*\n/g, "");
  if (!body.trim()) throw new HttpError(400, "Write a message first.");
  if (body.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `Messages are at most ${MAX_MESSAGE_CHARS} characters.`);
  const targets = await mentionTargets(ctx.workspaceId);
  const mentioned = parseMentions(body, targets);
  const authorName = authorNameOf(ctx);

  const out = await scoped(ctx, async (tx) => {
    const { channel, me } = await channelFor(tx, ctx, channelId);
    if (channel.archivedAt) throw new HttpError(409, "This channel is archived.");
    let parentId: string | null = null;
    if (input.parentId) {
      const parent = await tx.teamChatMessage.findFirst({ where: { id: input.parentId, channelId, workspaceId: ctx.workspaceId }, select: { id: true, parentId: true } });
      if (!parent) throw new HttpError(404, "That message is gone.");
      parentId = parent.parentId ?? parent.id; // a reply to a reply joins the thread
    }
    const now = new Date();
    // Posting in a project or public channel joins it.
    if (!me) {
      await tx.chatChannelMember.create({ data: { workspaceId: ctx.workspaceId, channelId, memberKey: userKey(ctx.userId), userId: ctx.userId, lastReadAt: now } });
    }
    const members = await tx.chatChannelMember.findMany({ where: { channelId }, select: { memberKey: true, userId: true, agentKey: true } });
    const memberKeys = new Set(members.map((m) => m.memberKey));
    const restricted = channel.kind === "dm" || channel.isPrivate;
    // Agents mentioned anywhere become members of the conversation (they read it to answer).
    const mentionedAgents = mentioned.filter((k) => k.startsWith("agent:"));
    const newAgents = mentionedAgents.filter((k) => !memberKeys.has(k) && channel.kind !== "dm");
    if (newAgents.length) {
      await tx.chatChannelMember.createMany({
        data: newAgents.map((k) => ({ workspaceId: ctx.workspaceId, channelId, memberKey: k, agentKey: k.slice("agent:".length) })),
        skipDuplicates: true,
      });
    }
    const row = await tx.teamChatMessage.create({
      data: { workspaceId: ctx.workspaceId, channelId, parentId, userId: ctx.userId, authorName, authorKind: "user", body, mentions: mentioned },
    });
    await tx.chatChannel.update({ where: { id: channelId }, data: { lastMessageAt: row.createdAt } });
    await tx.chatChannelMember.updateMany({ where: { channelId, memberKey: userKey(ctx.userId) }, data: { lastReadAt: row.createdAt } });

    // Who is told: in a DM every other person; elsewhere the mentioned people
    // who can see it (a private channel: members only).
    const dmPeople = channel.kind === "dm" ? members.filter((m) => m.userId && m.userId !== ctx.userId).map((m) => m.userId!) : [];
    const mentionedPeople = mentioned
      .filter((k) => k.startsWith("user:"))
      .map((k) => k.slice("user:".length))
      .filter((u) => u !== ctx.userId && (!restricted || memberKeys.has(userKey(u))))
      .filter((u) => !dmPeople.includes(u));
    // Agents to start: the mentioned ones; in a 1:1 DM with an agent, every message.
    let agents = mentionedAgents.map((k) => k.slice("agent:".length));
    if (!agents.length && channel.kind === "dm") {
      const dmAgents = members.filter((m) => m.agentKey).map((m) => m.agentKey!);
      const dmHumans = members.filter((m) => m.userId);
      if (dmAgents.length === 1 && dmHumans.length === 1) agents = dmAgents;
    }
    return { channel, row, dmPeople, mentionedPeople, agents, root: parentId ?? row.id };
  });

  const label = out.channel.kind === "dm" ? "a direct message" : `#${out.channel.name}`;
  const notice = { workspaceId: ctx.workspaceId, channelId, messageId: out.row.id, authorUserId: ctx.userId, authorName, channelName: label, body, href: messageHref(channelId, out.row.parentId ?? null) };
  if (out.dmPeople.length) await deps.notifyDirectMessage({ ...notice, userIds: out.dmPeople });
  if (out.mentionedPeople.length) await deps.notifyMention({ ...notice, userIds: out.mentionedPeople });

  let agentsSkipped: string | null = null;
  let agents = out.agents;
  if (agents.length && !roleAtLeast(ctx.role, "editor")) {
    agentsSkipped = "viewer";
    agents = [];
  }
  if (agents.length > MAX_AGENTS_PER_MESSAGE) {
    agentsSkipped = "too_many";
    agents = agents.slice(0, MAX_AGENTS_PER_MESSAGE);
  }
  for (const agentKey of agents) {
    await deps.startAgent({ workspaceId: ctx.workspaceId, channelId, messageId: out.row.id, agentKey, requestedBy: ctx.userId, mode: "turn" });
  }
  return { message: messageView(out.row), agents, agentsSkipped };
}

/** Edit your own message (mentions re-read; nobody is pinged again). */
export async function editMessage(ctx: MessagesCtx, messageId: string, body: string): Promise<MessageView> {
  const text = (body ?? "").trim();
  if (!text) throw new HttpError(400, "Write a message first.");
  if (text.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `Messages are at most ${MAX_MESSAGE_CHARS} characters.`);
  const targets = await mentionTargets(ctx.workspaceId);
  return scoped(ctx, async (tx) => {
    const row = await tx.teamChatMessage.findFirst({ where: { id: messageId, workspaceId: ctx.workspaceId } });
    if (!row) throw new HttpError(404, "Message not found.");
    await channelFor(tx, ctx, row.channelId);
    if (row.userId !== ctx.userId || row.authorKind !== "user") throw new HttpError(403, "You can only edit your own messages.");
    if ((row.meta as { removed?: boolean } | null)?.removed) throw new HttpError(409, "This message was removed.");
    const next = await tx.teamChatMessage.update({ where: { id: row.id }, data: { body: text, mentions: parseMentions(text, targets), editedAt: new Date() } });
    return messageView(next);
  });
}

/** Remove a message (its author, or an admin): the text goes, the thread stays. */
export async function removeMessage(ctx: MessagesCtx, messageId: string): Promise<MessageView> {
  return scoped(ctx, async (tx) => {
    const row = await tx.teamChatMessage.findFirst({ where: { id: messageId, workspaceId: ctx.workspaceId } });
    if (!row) throw new HttpError(404, "Message not found.");
    await channelFor(tx, ctx, row.channelId);
    const own = row.userId === ctx.userId && row.authorKind === "user";
    if (!own && !roleAtLeast(ctx.role, "admin")) throw new HttpError(403, "You can only remove your own messages.");
    const next = await tx.teamChatMessage.update({ where: { id: row.id }, data: { body: "", mentions: [], meta: { removed: true, by: ctx.userId }, editedAt: new Date() } });
    return messageView(next);
  });
}

/**
 * What changed in a channel since `cursor` (new, edited, removed messages,
 * agent cards whose decision moved). Reads a little before the cursor
 * (STREAM_OVERLAP_MS); the stream drops versions it already sent.
 */
export async function changesSince(ctx: MessagesCtx, channelId: string, cursor: Date): Promise<{ messages: MessageView[]; cursor: Date }> {
  const from = new Date(cursor.getTime() - STREAM_OVERLAP_MS);
  return scoped(ctx, async (tx) => {
    await channelFor(tx, ctx, channelId);
    const rows = await tx.teamChatMessage.findMany({
      where: { channelId, workspaceId: ctx.workspaceId, OR: [{ createdAt: { gt: from } }, { editedAt: { gt: from } }] },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    const roots = rows.filter((r) => !r.parentId).map((r) => r.id);
    const parents = [...new Set(rows.filter((r) => r.parentId).map((r) => r.parentId!))];
    const stats = await replyStats(tx, [...new Set([...roots, ...parents])]);
    let next = cursor;
    for (const r of rows) {
      const t = Math.max(r.createdAt.getTime(), r.editedAt?.getTime() ?? 0);
      if (t > next.getTime()) next = new Date(t);
    }
    // A new reply also changes its root's reply count: send the root along.
    const extraRoots = parents.filter((p) => !roots.includes(p));
    const rootRows = extraRoots.length ? await tx.teamChatMessage.findMany({ where: { id: { in: extraRoots } } }) : [];
    return { messages: [...rows.map((r) => messageView(r, stats.get(r.id))), ...rootRows.map((r) => messageView(r, stats.get(r.id)))], cursor: next };
  });
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export async function heartbeat(ctx: MessagesCtx): Promise<void> {
  await scoped(ctx, (tx) =>
    tx.userPresence.upsert({
      where: { workspaceId_userId: { workspaceId: ctx.workspaceId, userId: ctx.userId } },
      create: { workspaceId: ctx.workspaceId, userId: ctx.userId, lastSeenAt: new Date() },
      update: { lastSeenAt: new Date() },
    }),
  );
}

export interface PresenceView {
  userId: string;
  status: PresenceStatus;
  lastSeenAt: string | null;
}

/** Presence of workspace members (only members of this workspace are answered). */
export async function presenceFor(ctx: MessagesCtx, userIds: readonly string[], now = new Date()): Promise<PresenceView[]> {
  const members = new Set((await workspaceMembers(ctx.workspaceId)).map((m) => m.userId));
  const ids = [...new Set(userIds)].filter((u) => members.has(u)).slice(0, 200);
  if (!ids.length) return [];
  const rows = await scoped(ctx, (tx) => tx.userPresence.findMany({ where: { workspaceId: ctx.workspaceId, userId: { in: ids } }, select: { userId: true, lastSeenAt: true } }));
  const seen = new Map(rows.map((r) => [r.userId, r.lastSeenAt]));
  const { usersInFocus } = await import("@/lib/desktop/focus.server");
  const focus = await usersInFocus(ids, now).catch(() => new Set<string>());
  return ids.map((u) => ({ userId: u, status: presenceStatus(seen.get(u) ?? null, now, focus.has(u)), lastSeenAt: seen.get(u)?.toISOString() ?? null }));
}
