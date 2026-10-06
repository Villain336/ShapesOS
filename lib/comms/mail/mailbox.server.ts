// ShapesOS — Phase 18.2 (WS=comms): the Mail app's unified inbox — reads.
//
// Sources (lib/comms/mail/types.ts) and what each one reads:
//   gmail     the member's own Gmail (connector list_threads / get_thread;
//             gmail.readonly) — personal: only the member who connected it
//   outlook   the member's own Outlook (list_messages grouped by conversation,
//             list_conversation) — personal
//   crm       the CRM conversation inbox (lib/crm/inbox.ts) — the workspace's
//   social    Zernio DMs (lib/comms/mail/social.server.ts) — the workspace's
//
// Gmail / Outlook thread HEADERS are cached per mailbox (mail_thread_cache)
// for listing speed — subject, people, dates, provider labels; never bodies
// or previews. A listing refreshes a mailbox at most once a minute; a body is
// fetched from the provider when a thread is opened and never stored. Read /
// archive state and ShapesOS tags are the Mail app's own (the connectors'
// scopes are read-only for mailbox state, so nothing here changes the
// provider's mailbox). A connector answering from its labelled mock path is
// shown flagged and never cached.

import { HttpError } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { invokeConnection, ownConnection, personalConnections, type PersonalConnection } from "../connectors.server";
import { listSocialThreads, readSocialThread, platformLabel } from "./social.server";
import {
  groupByConversation,
  inFolder,
  matchesQuery,
  mergeThreads,
  parseParty,
  parseThreadKey,
  threadKey,
  type MailFolder,
  type MailMessageView,
  type MailSource,
  type MailThreadView,
} from "./types";

export interface MailCtx {
  workspaceId: string;
  userId: string;
  role: "viewer" | "editor" | "admin" | "owner";
}

export interface MailSourceStatus {
  source: MailSource;
  connected: boolean;
  accounts: { connectionId?: string; label: string }[];
  mock: boolean;
  error: string | null;
}

export interface MailboxListing {
  threads: MailThreadView[];
  sources: MailSourceStatus[];
}

/** How long a mailbox's cached headers count as fresh. */
export const MAILBOX_REFRESH_MS = 60_000;
const lastRefresh = new Map<string, number>();

interface Fresh {
  threads: MailThreadView[];
  /** Snippets of this refresh (key → text), shown now, never stored. */
  snippets: Map<string, string>;
  mock: boolean;
  error: string | null;
}

function viaOf(conn: PersonalConnection): string {
  return conn.account ?? (conn.connectorKey === "gmail" ? "Gmail" : "Outlook");
}

/** Pull a mailbox's recent threads from the provider and upsert their headers. */
async function refreshMailbox(ctx: MailCtx, conn: PersonalConnection, now = new Date()): Promise<Fresh> {
  const out: Fresh = { threads: [], snippets: new Map(), mock: false, error: null };
  const source = conn.connectorKey as "gmail" | "outlook";
  type Row = { externalId: string; latestMessageId: string | null; subject: string; from: string | null; participants: string[]; lastMessageAt: string; messageCount: number; unread: boolean; labels: string[]; snippet: string };
  let rows: Row[] = [];
  if (source === "gmail") {
    const res = await invokeConnection(conn, "list_threads", { labelIds: "INBOX", maxResults: 30 }, ctx);
    if (!res.ok) return { ...out, error: res.error ?? "Gmail did not answer." };
    out.mock = !!res.mock;
    const data = (res.data ?? {}) as { threads?: { id: string; subject: string; from: string; participants: string[]; lastMessageAt: string; messageCount: number; unread: boolean; labels: string[]; latestMessageId: string | null; snippet: string }[] };
    rows = (data.threads ?? []).map((t) => ({ externalId: t.id, latestMessageId: t.latestMessageId, subject: t.subject, from: t.from, participants: t.participants, lastMessageAt: t.lastMessageAt, messageCount: t.messageCount, unread: t.unread, labels: t.labels, snippet: t.snippet }));
  } else {
    const res = await invokeConnection(conn, "list_messages", { limit: 50 }, ctx);
    if (!res.ok) return { ...out, error: res.error ?? "Outlook did not answer." };
    out.mock = !!res.mock;
    const msgs = Array.isArray(res.data) ? (res.data as { id: string; subject: string; from: string | null; receivedAt: string | null; preview?: string; conversationId: string | null; isRead: boolean }[]) : [];
    rows = groupByConversation(msgs).map((c) => ({
      externalId: c.conversationId,
      latestMessageId: c.latestMessageId,
      subject: c.subject,
      from: c.from,
      participants: c.participants,
      lastMessageAt: c.lastMessageAt,
      messageCount: c.messageCount,
      unread: c.unread,
      labels: ["Inbox"],
      snippet: c.preview,
    }));
  }
  if (out.mock) {
    // The labelled mock path: shown, flagged, never cached.
    out.threads = rows.map((r) => ({
      key: threadKey({ source, connectionId: conn.id, externalId: r.externalId }),
      source,
      via: viaOf(conn),
      subject: r.subject,
      from: parseParty(r.from),
      participants: r.participants,
      snippet: r.snippet || null,
      lastMessageAt: new Date(r.lastMessageAt).toISOString(),
      messageCount: r.messageCount,
      unread: r.unread,
      archived: false,
      labels: r.labels,
      tags: [],
      suggestedTags: [],
      summary: null,
      channel: "email",
      mock: true,
      organizable: false,
    }));
    return out;
  }
  await withWorkspaceScope(ctx.workspaceId, async (tx) => {
    for (const r of rows) {
      const at = new Date(r.lastMessageAt);
      if (Number.isNaN(at.getTime())) continue;
      const party = parseParty(r.from);
      const where = { workspaceId_connectionId_externalId: { workspaceId: ctx.workspaceId, connectionId: conn.id, externalId: r.externalId } };
      const prior = await tx.mailThreadCache.findUnique({ where, select: { lastMessageAt: true } });
      const newMessage = !prior || at.getTime() > prior.lastMessageAt.getTime();
      await tx.mailThreadCache.upsert({
        where,
        create: {
          workspaceId: ctx.workspaceId,
          connectionId: conn.id,
          ownerUserId: conn.userId,
          source,
          externalId: r.externalId,
          latestMessageId: r.latestMessageId,
          subject: r.subject.slice(0, 500) || "",
          fromName: party.name?.slice(0, 200) ?? null,
          fromEmail: party.address?.slice(0, 200) ?? null,
          participants: r.participants.slice(0, 50),
          lastMessageAt: at,
          messageCount: r.messageCount,
          unread: r.unread,
          labels: r.labels.slice(0, 30),
          fetchedAt: now,
        },
        update: {
          latestMessageId: r.latestMessageId,
          subject: r.subject.slice(0, 500) || "",
          fromName: party.name?.slice(0, 200) ?? null,
          fromEmail: party.address?.slice(0, 200) ?? null,
          participants: r.participants.slice(0, 50),
          lastMessageAt: at,
          messageCount: r.messageCount,
          labels: r.labels.slice(0, 30),
          fetchedAt: now,
          // A new message makes the thread unread (and back in the inbox) per the provider; otherwise the Mail app's own state stands.
          ...(newMessage ? { unread: r.unread, ...(r.unread ? { archived: false } : {}) } : {}),
        },
      });
      out.snippets.set(threadKey({ source, connectionId: conn.id, externalId: r.externalId }), r.snippet);
    }
  });
  return out;
}

function cachedView(row: {
  connectionId: string;
  source: string;
  externalId: string;
  subject: string;
  fromName: string | null;
  fromEmail: string | null;
  participants: string[];
  lastMessageAt: Date;
  messageCount: number;
  unread: boolean;
  archived: boolean;
  labels: string[];
  tags: string[];
  suggestedTags: string[];
  summary: string | null;
}, via: string, snippet: string | null): MailThreadView {
  const source = row.source === "outlook" ? "outlook" : "gmail";
  return {
    key: threadKey({ source, connectionId: row.connectionId, externalId: row.externalId }),
    source,
    via,
    subject: row.subject,
    from: { name: row.fromName, address: row.fromEmail },
    participants: row.participants,
    snippet,
    lastMessageAt: row.lastMessageAt.toISOString(),
    messageCount: row.messageCount,
    unread: row.unread,
    archived: row.archived,
    labels: row.labels,
    tags: row.tags,
    suggestedTags: row.suggestedTags,
    summary: row.summary,
    channel: "email",
    mock: false,
    organizable: true,
  };
}

async function crmThreads(ctx: MailCtx, folder: MailFolder, q: string | null, limit: number): Promise<MailThreadView[]> {
  if (folder === "archived") return []; // the CRM inbox has no archive
  const { listThreads } = await import("@/lib/crm/inbox");
  const list = await withWorkspaceScope(ctx.workspaceId, (tx) =>
    listThreads(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, unread: folder === "unread", assigned: "any", q, limit }),
  );
  return list.threads.map((t) => ({
    key: threadKey({ source: "crm", leadId: t.leadId }),
    source: "crm" as const,
    via: t.lastChannel === "sms" ? "SMS" : "CRM email",
    subject: t.leadName,
    from: { name: t.leadName, address: t.leadEmail ?? t.leadPhone ?? null },
    participants: [t.leadEmail, t.leadPhone].filter((x): x is string => !!x),
    snippet: t.lastSnippet || null,
    lastMessageAt: t.lastMessageAt,
    messageCount: t.messageCount,
    unread: t.unreadCount > 0,
    archived: false,
    labels: t.channels,
    tags: [],
    suggestedTags: [],
    summary: null,
    channel: t.lastChannel,
    mock: false,
    organizable: false,
  }));
}

/**
 * The unified inbox for a member: their mailboxes (refreshed when stale),
 * the CRM inbox and the workspace's social DMs, filtered and merged
 * newest first. Each source's failure is reported, never hides the others.
 */
export async function listMailbox(
  ctx: MailCtx,
  opts: { folder?: MailFolder; q?: string | null; source?: MailSource | null; tag?: string | null; limit?: number; refresh?: boolean } = {},
): Promise<MailboxListing> {
  const folder = opts.folder ?? "inbox";
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const want = (s: MailSource) => !opts.source || opts.source === s;
  const sources: MailSourceStatus[] = [];
  const lists: MailThreadView[][] = [];

  const conns = await personalConnections(ctx.workspaceId, ctx.userId, ["gmail", "outlook"]);
  for (const key of ["gmail", "outlook"] as const) {
    const mine = conns.filter((c) => c.connectorKey === key);
    const status: MailSourceStatus = { source: key, connected: mine.length > 0, accounts: mine.map((c) => ({ connectionId: c.id, label: viaOf(c) })), mock: false, error: null };
    sources.push(status);
    if (!want(key) || !mine.length) continue;
    const snippets = new Map<string, string>();
    for (const conn of mine) {
      const stale = opts.refresh || Date.now() - (lastRefresh.get(conn.id) ?? 0) > MAILBOX_REFRESH_MS;
      if (!stale) continue;
      const fresh = await refreshMailbox(ctx, conn).catch((err) => ({ threads: [], snippets: new Map<string, string>(), mock: false, error: err instanceof Error ? err.message : "error" }) as Fresh);
      if (fresh.error) status.error = fresh.error.slice(0, 200);
      else lastRefresh.set(conn.id, Date.now());
      if (fresh.mock) {
        status.mock = true;
        lists.push(fresh.threads.filter((t) => inFolder(t, folder) && matchesQuery(t, opts.q)));
      }
      for (const [k, v] of fresh.snippets) snippets.set(k, v);
    }
    const via = new Map(mine.map((c) => [c.id, viaOf(c)]));
    const rows = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      tx.mailThreadCache.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ownerUserId: ctx.userId,
          connectionId: { in: mine.map((c) => c.id) },
          ...(folder === "archived" ? { archived: true } : { archived: false }),
          ...(folder === "unread" ? { unread: true } : {}),
          ...(opts.tag ? { tags: { has: opts.tag } } : {}),
        },
        orderBy: { lastMessageAt: "desc" },
        take: 500,
      }),
    );
    lists.push(rows.map((r) => cachedView(r, via.get(r.connectionId) ?? key, snippets.get(threadKey({ source: key, connectionId: r.connectionId, externalId: r.externalId })) ?? null)).filter((t) => matchesQuery(t, opts.q)));
  }

  const crmStatus: MailSourceStatus = { source: "crm", connected: true, accounts: [{ label: "CRM inbox" }], mock: false, error: null };
  sources.push(crmStatus);
  if (want("crm") && !opts.tag) {
    lists.push(await crmThreads(ctx, folder, opts.q ?? null, limit).catch((err) => {
      crmStatus.error = err instanceof Error ? err.message.slice(0, 200) : "error";
      return [];
    }));
  }

  const social = want("social") && !opts.tag ? await listSocialThreads(ctx.workspaceId, limit) : { mode: "off" as const, accounts: 0, threads: [], error: null };
  sources.push({ source: "social", connected: social.accounts > 0, accounts: social.accounts ? [{ label: `${social.accounts} social account${social.accounts === 1 ? "" : "s"}` }] : [], mock: social.mode === "mock", error: social.error });
  lists.push(social.threads.filter((t) => inFolder(t, folder) && matchesQuery(t, opts.q)));

  return { threads: mergeThreads(lists, limit), sources };
}

export interface MailThreadDetail {
  thread: MailThreadView;
  messages: MailMessageView[];
  /** What a reply goes through. */
  reply: { source: MailSource; to: string[]; subject: string | null; channels: string[]; connectionId?: string; replyToMessageId?: string | null };
}

/** Open one thread (bodies from the provider). `markRead`: a person opened it. */
export async function readMailThread(ctx: MailCtx, key: string, opts: { markRead?: boolean } = {}): Promise<MailThreadDetail> {
  const ref = parseThreadKey(key);
  if (!ref) throw new HttpError(400, "That is not a mail thread.");
  if (ref.source === "crm") {
    const { getThread, markThreadRead } = await import("@/lib/crm/inbox");
    const detail = await withWorkspaceScope(ctx.workspaceId, (tx) => getThread(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, leadId: ref.leadId }));
    if (opts.markRead) await withWorkspaceScope(ctx.workspaceId, (tx) => markThreadRead(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, leadId: ref.leadId })).catch(() => undefined);
    const lead = detail.lead;
    const last = detail.messages[detail.messages.length - 1];
    return {
      thread: {
        key,
        source: "crm",
        via: last?.channel === "sms" ? "SMS" : "CRM email",
        subject: lead.name,
        from: { name: lead.name, address: lead.email ?? lead.phone },
        participants: [lead.email, lead.phone].filter((x): x is string => !!x),
        snippet: null,
        lastMessageAt: last?.createdAt ?? new Date().toISOString(),
        messageCount: detail.messages.length,
        unread: false,
        archived: false,
        labels: [],
        tags: [],
        suggestedTags: [],
        summary: null,
        channel: last?.channel ?? null,
        mock: false,
        organizable: false,
      },
      messages: detail.messages.map((m) => ({
        id: m.id,
        from: m.direction === "inbound" ? { name: lead.name, address: lead.email ?? lead.phone } : { name: null, address: null },
        to: [],
        cc: [],
        at: m.createdAt,
        subject: m.subject,
        body: m.body,
        direction: m.direction,
        status: m.status,
        channel: m.channel,
      })),
      reply: { source: "crm", to: [lead.email ?? lead.phone ?? ""].filter(Boolean), subject: detail.lastEmailSubject, channels: [lead.email ? "email" : null, lead.phone ? "sms" : null].filter((x): x is string => !!x) },
    };
  }
  if (ref.source === "social") {
    const r = await readSocialThread(ctx.workspaceId, ref, opts);
    const last = r.messages[r.messages.length - 1];
    const other = r.messages.find((m) => m.direction === "inbound")?.from ?? { name: null, address: null };
    return {
      thread: {
        key,
        source: "social",
        via: platformLabel(r.platform ?? ""),
        subject: other.name ?? platformLabel(r.platform ?? ""),
        from: other,
        participants: other.name ? [other.name] : [],
        snippet: null,
        lastMessageAt: last?.at ?? new Date().toISOString(),
        messageCount: r.messages.length,
        unread: false,
        archived: false,
        labels: [],
        tags: [],
        suggestedTags: [],
        summary: null,
        channel: r.platform,
        mock: r.mock,
        organizable: false,
      },
      messages: r.messages,
      reply: { source: "social", to: other.name ? [other.name] : [], subject: null, channels: [r.platform ?? "dm"] },
    };
  }
  // Gmail / Outlook: the member's own mailbox only.
  const conn = await ownConnection(ctx.workspaceId, ctx.userId, ref.connectionId, [ref.source]);
  if (!conn) throw new HttpError(404, "Thread not found.");
  const res =
    ref.source === "gmail"
      ? await invokeConnection(conn, "get_thread", { threadId: ref.externalId }, ctx)
      : await invokeConnection(conn, "list_conversation", { conversationId: ref.externalId }, ctx);
  if (!res.ok) throw new HttpError(502, res.error ?? "The mailbox did not answer.");
  type Msg = { id: string; from: string | null; to?: string[]; cc?: string[]; date?: string; receivedAt?: string | null; subject?: string; bodyText?: string };
  const raw: Msg[] = ref.source === "gmail" ? (((res.data ?? {}) as { messages?: Msg[] }).messages ?? []) : Array.isArray(res.data) ? (res.data as Msg[]) : [];
  const me = (conn.account ?? "").toLowerCase();
  const messages: MailMessageView[] = raw.map((m) => {
    const from = parseParty(m.from);
    return {
      id: m.id,
      from,
      to: m.to ?? [],
      cc: m.cc ?? [],
      at: m.date ?? m.receivedAt ?? new Date(0).toISOString(),
      subject: m.subject ?? null,
      body: m.bodyText ?? "",
      direction: me && from.address === me ? "outbound" : "inbound",
      status: null,
      channel: "email",
    };
  });
  const row = res.mock
    ? null
    : await withWorkspaceScope(ctx.workspaceId, async (tx) => {
        const where = { workspaceId_connectionId_externalId: { workspaceId: ctx.workspaceId, connectionId: conn.id, externalId: ref.externalId } };
        const found = await tx.mailThreadCache.findUnique({ where });
        if (found && opts.markRead && found.unread) return tx.mailThreadCache.update({ where, data: { unread: false } });
        return found;
      });
  const last = messages[messages.length - 1];
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound") ?? last;
  const thread: MailThreadView = row
    ? cachedView(row, viaOf(conn), null)
    : {
        key,
        source: ref.source,
        via: viaOf(conn),
        subject: messages[0]?.subject ?? "",
        from: lastInbound?.from ?? { name: null, address: null },
        participants: [...new Set(messages.flatMap((m) => [m.from.address, ...m.to]).filter((x): x is string => !!x))],
        snippet: null,
        lastMessageAt: last?.at ?? new Date().toISOString(),
        messageCount: messages.length,
        unread: false,
        archived: false,
        labels: [],
        tags: [],
        suggestedTags: [],
        summary: null,
        channel: "email",
        mock: !!res.mock,
        organizable: false,
      };
  return {
    thread,
    messages,
    reply: {
      source: ref.source,
      connectionId: conn.id,
      to: lastInbound?.from.address ? [lastInbound.from.address] : [],
      subject: thread.subject,
      channels: ["email"],
      replyToMessageId: lastInbound?.id ?? last?.id ?? null,
    },
  };
}

/** Archive / unarchive, read / unread, tags — the Mail app's own state on a cached Gmail / Outlook thread. */
export async function organizeThread(
  ctx: MailCtx,
  key: string,
  patch: { archived?: boolean; unread?: boolean; addTags?: string[]; removeTags?: string[]; acceptSuggested?: boolean },
): Promise<MailThreadView> {
  const ref = parseThreadKey(key);
  if (!ref || (ref.source !== "gmail" && ref.source !== "outlook")) throw new HttpError(400, "Only Gmail and Outlook threads can be archived or labelled here.");
  return withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const where = { workspaceId_connectionId_externalId: { workspaceId: ctx.workspaceId, connectionId: ref.connectionId, externalId: ref.externalId } };
    const row = await tx.mailThreadCache.findUnique({ where });
    if (!row || row.ownerUserId !== ctx.userId) throw new HttpError(404, "Thread not found.");
    const tags = new Set(row.tags);
    for (const t of patch.addTags ?? []) tags.add(t);
    if (patch.acceptSuggested) for (const t of row.suggestedTags) tags.add(t);
    for (const t of patch.removeTags ?? []) tags.delete(t);
    const updated = await tx.mailThreadCache.update({
      where,
      data: {
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
        ...(patch.unread !== undefined ? { unread: patch.unread } : {}),
        tags: [...tags].slice(0, 20),
        ...(patch.acceptSuggested ? { suggestedTags: [] } : {}),
      },
    });
    const conn = await ownConnection(ctx.workspaceId, ctx.userId, ref.connectionId, [ref.source]);
    return cachedView(updated, conn ? viaOf(conn) : ref.source, null);
  });
}

/** Forget the cache refresh times (tests). */
export function _resetMailboxRefreshForTests(): void {
  lastRefresh.clear();
}
