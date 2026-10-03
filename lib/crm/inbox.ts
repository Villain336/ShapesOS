// ShapesOS — CRM conversation inbox (Phase 4b).
//
// One thread per lead, merged from the messaging ledger (`outbound_message`):
//   - outbound rows: manual sends, sequences, speed-to-lead, review requests…
//     (queued behind an approval, sent, delivered, failed or suppressed)
//   - inbound rows: direction "inbound" — today inbound SMS
//     (lib/messaging/consent.ts handleInboundSms logs every inbound text to
//     the same ledger, matched to a lead by phone). Any channel logged with
//     direction "inbound" threads the same way, so inbound email lands in the
//     right thread as soon as an inbound-email path writes to the ledger.
// Inbound rows that matched no lead (lead_id NULL) can't be threaded and are
// only counted (`unmatchedInbound`).
//
// Unread state is per user: `conversation_reads` holds each user's last-read
// time per lead (FORCE RLS). A thread is unread for a user when it has an
// inbound message newer than that marker.
//
// Every function takes the transaction client from withWorkspaceScope(), so
// the RLS-protected read markers are visible; the ledger and lead rows are
// additionally filtered by workspace_id in every query.
//
// Replies never send directly: replyToThread() goes through the messaging
// dispatcher's queueMessage(), which applies consent, quiet hours, the daily
// cap and the human-approval gate exactly like POST /api/messaging/send.

import { Prisma } from "@prisma/client";
import type { OutboundMessage, PrismaClient } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/api/errors";

type Db = Prisma.TransactionClient | PrismaClient;

export type InboxChannel = "sms" | "email";
export type AssignedFilter = "any" | "me" | "unassigned";

export interface ThreadFilters {
  channel?: InboxChannel | null;
  unread?: boolean;
  assigned?: AssignedFilter;
  /** Matches lead name, email, phone or company (case-insensitive). */
  q?: string | null;
  /** Opaque cursor from a previous page (`nextCursor`). */
  cursor?: string | null;
  limit?: number;
}

export interface ThreadSummary {
  leadId: string;
  leadName: string;
  leadEmail: string | null;
  leadPhone: string | null;
  ownerId: string | null;
  ownerName: string | null;
  lastMessageAt: string;
  lastChannel: string;
  lastDirection: string;
  lastStatus: string;
  /** First 200 characters of the newest message (subject for an email without a body). */
  lastSnippet: string;
  messageCount: number;
  inboundCount: number;
  unreadCount: number;
  channels: string[];
}

export interface ThreadList {
  threads: ThreadSummary[];
  nextCursor: string | null;
  /** Threads (across the whole inbox, ignoring filters) with unread inbound messages. */
  unreadThreads: number;
  /** Inbound messages that matched no lead (can't be threaded). */
  unmatchedInbound: number;
}

export interface ThreadMessage {
  id: string;
  channel: string;
  direction: "inbound" | "outbound";
  kind: string;
  subject: string | null;
  body: string;
  status: string;
  suppressionReason: string | null;
  error: string | null;
  approvalId: string | null;
  /** ApprovalItem status for an outbound row waiting on (or decided by) a human. */
  approvalStatus: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
}

export interface ThreadDetail {
  lead: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    company: string | null;
    ownerId: string | null;
    ownerName: string | null;
    stage: string;
  };
  messages: ThreadMessage[];
  lastReadAt: string | null;
  unreadCount: number;
  /** The newest email subject in the thread, for a "Re:" default. */
  lastEmailSubject: string | null;
}

export const THREAD_PAGE_MAX = 100;
export const THREAD_MESSAGES_MAX = 300;

const CHANNELS: readonly InboxChannel[] = ["sms", "email"];

export function isInboxChannel(v: unknown): v is InboxChannel {
  return typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
}

// ── Cursor (lastMessageAt + leadId, newest first) ───────────────────────────

export function encodeCursor(lastMessageAt: Date | string, leadId: string): string {
  const iso = typeof lastMessageAt === "string" ? lastMessageAt : lastMessageAt.toISOString();
  return Buffer.from(`${iso}|${leadId}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): { at: Date; leadId: string } | null {
  if (!cursor || cursor.length > 200) return null;
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = raw.indexOf("|");
  if (sep <= 0) return null;
  const at = new Date(raw.slice(0, sep));
  const leadId = raw.slice(sep + 1);
  if (Number.isNaN(at.getTime()) || !leadId || leadId.length > 64) return null;
  return { at, leadId };
}

/** "Re: <subject>" unless it already starts with Re:. */
export function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? "").trim();
  if (!s) return "";
  return /^re:/i.test(s) ? s.slice(0, 200) : `Re: ${s}`.slice(0, 200);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface ThreadRow {
  lead_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  owner_id: string | null;
  owner_name: string | null;
  last_at: Date;
  message_count: number;
  inbound_count: number;
  unread_count: number;
  channels: string[] | null;
  last_channel: string | null;
  last_direction: string | null;
  last_status: string | null;
  last_snippet: string | null;
}

/**
 * Threads for one user, newest activity first. Filters: channel (threads
 * with a message on that channel; counts and the preview are per channel),
 * unread (threads with unread inbound messages), assigned (lead owner is the
 * caller / nobody), q (lead name, email, phone, company).
 */
export async function listThreads(
  db: Db,
  opts: { workspaceId: string; userId: string } & ThreadFilters,
): Promise<ThreadList> {
  const ws = opts.workspaceId;
  const take = Math.min(Math.max(Math.trunc(opts.limit ?? 30), 1), THREAD_PAGE_MAX);
  const channel = isInboxChannel(opts.channel) ? opts.channel : null;
  const cursor = decodeCursor(opts.cursor);
  const q = (opts.q ?? "").trim().slice(0, 120);

  const channelSql = channel ? Prisma.sql`AND m.channel = ${channel}` : Prisma.empty;
  const conds: Prisma.Sql[] = [];
  if (opts.assigned === "me") conds.push(Prisma.sql`t.owner_id = ${opts.userId}`);
  else if (opts.assigned === "unassigned") conds.push(Prisma.sql`t.owner_id IS NULL`);
  if (opts.unread) conds.push(Prisma.sql`t.unread_count > 0`);
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conds.push(
      Prisma.sql`(t.name ILIKE ${like} OR t.email ILIKE ${like} OR t.phone ILIKE ${like} OR t.company ILIKE ${like})`,
    );
  }
  if (cursor) {
    conds.push(Prisma.sql`(t.last_at < ${cursor.at} OR (t.last_at = ${cursor.at} AND t.lead_id < ${cursor.leadId}))`);
  }
  const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;

  const rows = await db.$queryRaw<ThreadRow[]>`
    WITH msgs AS (
      SELECT m.lead_id, m.channel, m.direction, m.status, m.subject, m.body, m.created_at, m.id
      FROM outbound_message m
      WHERE m.workspace_id = ${ws} AND m.lead_id IS NOT NULL ${channelSql}
    ),
    agg AS (
      SELECT lead_id,
             max(created_at) AS last_at,
             count(*)::int AS message_count,
             (count(*) FILTER (WHERE direction = 'inbound'))::int AS inbound_count,
             array_agg(DISTINCT channel) AS channels
      FROM msgs GROUP BY lead_id
    ),
    t AS (
      SELECT a.lead_id, a.last_at, a.message_count, a.inbound_count, a.channels,
             l.name, l.email, l.phone, l.company, l.owner_id, l.owner_name,
             (SELECT count(*)::int FROM msgs u
               WHERE u.lead_id = a.lead_id AND u.direction = 'inbound'
                 AND (r.last_read_at IS NULL OR u.created_at > r.last_read_at)) AS unread_count
      FROM agg a
      JOIN crm_leads l ON l.id = a.lead_id AND l.workspace_id = ${ws}
      LEFT JOIN conversation_reads r
        ON r.workspace_id = ${ws} AND r.user_id = ${opts.userId} AND r.lead_id = a.lead_id
    )
    SELECT t.lead_id, t.name, t.email, t.phone, t.owner_id, t.owner_name, t.last_at,
           t.message_count, t.inbound_count, t.unread_count, t.channels,
           last.channel AS last_channel, last.direction AS last_direction, last.status AS last_status,
           left(coalesce(nullif(last.body, ''), last.subject, ''), 200) AS last_snippet
    FROM t
    LEFT JOIN LATERAL (
      SELECT channel, direction, status, subject, body FROM msgs x
      WHERE x.lead_id = t.lead_id ORDER BY x.created_at DESC, x.id DESC LIMIT 1
    ) last ON true
    ${where}
    ORDER BY t.last_at DESC, t.lead_id DESC
    LIMIT ${take + 1}`;

  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  const [unread] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(DISTINCT m.lead_id)::int AS n
    FROM outbound_message m
    JOIN crm_leads l ON l.id = m.lead_id AND l.workspace_id = ${ws}
    LEFT JOIN conversation_reads r
      ON r.workspace_id = ${ws} AND r.user_id = ${opts.userId} AND r.lead_id = m.lead_id
    WHERE m.workspace_id = ${ws} AND m.direction = 'inbound'
      AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)`;
  const [unmatched] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM outbound_message
    WHERE workspace_id = ${ws} AND direction = 'inbound' AND lead_id IS NULL`;

  return {
    threads: page.map((r) => ({
      leadId: r.lead_id,
      leadName: r.name,
      leadEmail: r.email,
      leadPhone: r.phone,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      lastMessageAt: new Date(r.last_at).toISOString(),
      lastChannel: r.last_channel ?? "",
      lastDirection: r.last_direction ?? "outbound",
      lastStatus: r.last_status ?? "",
      lastSnippet: r.last_snippet ?? "",
      messageCount: Number(r.message_count),
      inboundCount: Number(r.inbound_count),
      unreadCount: Number(r.unread_count),
      channels: (r.channels ?? []).filter(Boolean).sort(),
    })),
    nextCursor: rows.length > take && last ? encodeCursor(new Date(last.last_at), last.lead_id) : null,
    unreadThreads: Number(unread?.n ?? 0),
    unmatchedInbound: Number(unmatched?.n ?? 0),
  };
}

async function leadInWorkspace(db: Db, workspaceId: string, leadId: string) {
  const lead = await db.lead.findFirst({
    where: { id: leadId, workspaceId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      company: true,
      ownerId: true,
      ownerName: true,
      stage: true,
    },
  });
  if (!lead) throw new NotFoundError("Conversation not found.");
  return lead;
}

function toMessage(m: OutboundMessage, approvals: Map<string, string>): ThreadMessage {
  return {
    id: m.id,
    channel: m.channel,
    direction: m.direction === "inbound" ? "inbound" : "outbound",
    kind: m.kind,
    subject: m.subject,
    body: m.body,
    status: m.status,
    suppressionReason: m.suppressionReason,
    error: m.direction === "inbound" ? null : m.error,
    approvalId: m.approvalId,
    approvalStatus: m.approvalId ? approvals.get(m.approvalId) ?? null : null,
    createdAt: m.createdAt.toISOString(),
    sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    deliveredAt: m.deliveredAt ? m.deliveredAt.toISOString() : null,
  };
}

/** One lead's thread, oldest first (the newest THREAD_MESSAGES_MAX messages). */
export async function getThread(
  db: Db,
  opts: { workspaceId: string; userId: string; leadId: string; channel?: InboxChannel | null },
): Promise<ThreadDetail> {
  const lead = await leadInWorkspace(db, opts.workspaceId, opts.leadId);
  const channel = isInboxChannel(opts.channel) ? opts.channel : undefined;
  const rows = await db.outboundMessage.findMany({
    where: { workspaceId: opts.workspaceId, leadId: lead.id, ...(channel ? { channel } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: THREAD_MESSAGES_MAX,
  });
  rows.reverse();
  const approvalIds = [...new Set(rows.map((r) => r.approvalId).filter((v): v is string => !!v))];
  const approvals = new Map<string, string>();
  if (approvalIds.length) {
    const items = await db.approvalItem.findMany({
      where: { workspaceId: opts.workspaceId, id: { in: approvalIds } },
      select: { id: true, status: true },
    });
    for (const i of items) approvals.set(i.id, i.status);
  }
  const marker = await db.conversationRead.findUnique({
    where: { workspaceId_userId_leadId: { workspaceId: opts.workspaceId, userId: opts.userId, leadId: lead.id } },
    select: { lastReadAt: true },
  });
  const lastReadAt = marker?.lastReadAt ?? null;
  const unreadCount = rows.filter(
    (r) => r.direction === "inbound" && (!lastReadAt || r.createdAt.getTime() > lastReadAt.getTime()),
  ).length;
  const lastEmail = [...rows].reverse().find((r) => r.channel === "email" && r.subject?.trim());
  return {
    lead,
    messages: rows.map((r) => toMessage(r, approvals)),
    lastReadAt: lastReadAt ? lastReadAt.toISOString() : null,
    unreadCount,
    lastEmailSubject: lastEmail?.subject ?? null,
  };
}

/**
 * Mark a thread read for this user up to `at` (default now). The marker only
 * moves forward, so a stale tab can't un-read newer messages.
 */
export async function markThreadRead(
  db: Db,
  opts: { workspaceId: string; userId: string; leadId: string; at?: Date },
): Promise<{ lastReadAt: string }> {
  const lead = await leadInWorkspace(db, opts.workspaceId, opts.leadId);
  const at = opts.at && !Number.isNaN(opts.at.getTime()) ? opts.at : new Date();
  const capped = at.getTime() > Date.now() ? new Date() : at;
  const key = { workspaceId: opts.workspaceId, userId: opts.userId, leadId: lead.id };
  const existing = await db.conversationRead.findUnique({
    where: { workspaceId_userId_leadId: key },
    select: { lastReadAt: true },
  });
  if (existing && existing.lastReadAt.getTime() >= capped.getTime()) {
    return { lastReadAt: existing.lastReadAt.toISOString() };
  }
  const row = await db.conversationRead.upsert({
    where: { workspaceId_userId_leadId: key },
    create: { ...key, lastReadAt: capped },
    update: { lastReadAt: capped },
    select: { lastReadAt: true },
  });
  return { lastReadAt: row.lastReadAt.toISOString() };
}

/** Mark a thread unread again: drop this user's marker. */
export async function markThreadUnread(
  db: Db,
  opts: { workspaceId: string; userId: string; leadId: string },
): Promise<void> {
  await leadInWorkspace(db, opts.workspaceId, opts.leadId);
  await db.conversationRead.deleteMany({
    where: { workspaceId: opts.workspaceId, userId: opts.userId, leadId: opts.leadId },
  });
}

// ── Replies ─────────────────────────────────────────────────────────────────

export const REPLY_SMS_MAX = 1600;
export const REPLY_EMAIL_MAX = 5000;
export const REPLY_SUBJECT_MAX = 200;

export interface ReplyDraft {
  channel: InboxChannel;
  subject?: string | null;
  body: string;
}

/** The first problem with a reply draft, or null when it can be queued. */
export function validateReply(d: ReplyDraft): string | null {
  if (!isInboxChannel(d.channel)) return "Pick SMS or email.";
  const body = (d.body ?? "").trim();
  if (!body) return "Write a message first.";
  if (d.channel === "sms") {
    if (body.length > REPLY_SMS_MAX) return `Keep texts under ${REPLY_SMS_MAX} characters.`;
    return null;
  }
  const subject = (d.subject ?? "").trim();
  if (!subject) return "Add a subject.";
  if (subject.length > REPLY_SUBJECT_MAX) return `Keep the subject under ${REPLY_SUBJECT_MAX} characters.`;
  if (body.length > REPLY_EMAIL_MAX) return `Keep the message under ${REPLY_EMAIL_MAX} characters.`;
  return null;
}

export type QueueReplyFn = (input: {
  workspaceId: string;
  leadId: string;
  channel: InboxChannel;
  kind: "manual";
  subject?: string;
  body: string;
  requestedBy?: string;
}) => Promise<OutboundMessage>;

export interface ReplyOutcome {
  message: ThreadMessage;
  /** queued = waiting on approval (or quiet hours); suppressed = consent/cap/contact blocked it. */
  outcome: "queued" | "sent" | "suppressed" | "failed";
}

/**
 * Queue a reply on a lead's thread through the messaging dispatcher (consent,
 * quiet hours, daily cap and the approval gate all apply there). The lead
 * must belong to the workspace; the caller's role is checked by the route.
 * `queue` is the dispatcher's queueMessage (injected so this module stays
 * free of provider imports and is unit-testable).
 */
export async function replyToThread(
  db: Db,
  queue: QueueReplyFn,
  opts: { workspaceId: string; userId: string; leadId: string } & ReplyDraft,
): Promise<ReplyOutcome> {
  const problem = validateReply(opts);
  if (problem) throw new BadRequestError(problem);
  const lead = await leadInWorkspace(db, opts.workspaceId, opts.leadId);
  if (opts.channel === "sms" && !lead.phone?.trim()) throw new BadRequestError("Add a phone number to this lead first.");
  if (opts.channel === "email" && !lead.email?.trim()) throw new BadRequestError("Add an email address to this lead first.");
  const row = await queue({
    workspaceId: opts.workspaceId,
    leadId: lead.id,
    channel: opts.channel,
    kind: "manual",
    subject: opts.channel === "email" ? (opts.subject ?? "").trim() : undefined,
    body: opts.body.trim(),
    requestedBy: opts.userId,
  });
  const outcome: ReplyOutcome["outcome"] =
    row.status === "suppressed"
      ? "suppressed"
      : row.status === "failed"
        ? "failed"
        : row.status === "sent" || row.status === "delivered"
          ? "sent"
          : "queued";
  return { message: toMessage(row, new Map(row.approvalId ? [[row.approvalId, "pending"]] : [])), outcome };
}

/** Human copy for a suppression reason (dispatcher vocabulary). */
export function suppressionLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "opt_out":
      return "The lead opted out of this channel.";
    case "no_consent":
      return "No consent on file for this channel. Record consent on the lead first.";
    case "cap":
      return "The workspace's daily send cap is reached. It can go out tomorrow.";
    case "invalid_contact":
      return "The lead has no address for this channel.";
    default:
      return reason ? `Not sent (${reason.replace(/_/g, " ")}).` : "Not sent.";
  }
}
