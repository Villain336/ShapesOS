// ShapesOS — Phase 18.2 (WS=comms): the Mail app's unified thread model
// (PURE, client-safe). One inbox over the sources that already exist:
//
//   gmail / outlook  the member's own mailboxes (connector reads; headers
//                    cached in mail_thread_cache, bodies fetched on open)
//   crm              the CRM conversation inbox (email + SMS with leads)
//   social           social DMs through Zernio's inbox (Instagram, Messenger,
//                    WhatsApp, X, Telegram, Bluesky, Reddit)
//
// A thread key names its source and the source's own ids, so the Mail app
// never needs a mailbox store of its own.

export const MAIL_SOURCES = ["gmail", "outlook", "crm", "social"] as const;
export type MailSource = (typeof MAIL_SOURCES)[number];

export function isMailSource(v: unknown): v is MailSource {
  return typeof v === "string" && (MAIL_SOURCES as readonly string[]).includes(v);
}

export type ThreadRef =
  | { source: "gmail" | "outlook"; connectionId: string; externalId: string }
  | { source: "crm"; leadId: string }
  | { source: "social"; accountId: string; conversationId: string };

const ID_RE = /^[A-Za-z0-9_\-=+/.@]{1,600}$/;

/** "gmail:<connection>:<thread>" · "outlook:<connection>:<conversation>" · "crm:<lead>" · "social:<account>:<conversation>" */
export function threadKey(ref: ThreadRef): string {
  switch (ref.source) {
    case "crm":
      return `crm:${ref.leadId}`;
    case "social":
      return `social:${ref.accountId}:${ref.conversationId}`;
    default:
      return `${ref.source}:${ref.connectionId}:${ref.externalId}`;
  }
}

/** Parse a thread key (null when malformed). The last part may contain ':' (opaque provider ids). */
export function parseThreadKey(key: unknown): ThreadRef | null {
  if (typeof key !== "string" || key.length > 900) return null;
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const source = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (source === "crm") return ID_RE.test(rest) && !rest.includes(":") ? { source: "crm", leadId: rest } : null;
  const j = rest.indexOf(":");
  if (j <= 0) return null;
  const a = rest.slice(0, j);
  const b = rest.slice(j + 1);
  if (!a || !b || b.length > 600 || /[\s]/.test(b) || !/^[A-Za-z0-9_-]{1,64}$/.test(a)) return null;
  if (source === "gmail" || source === "outlook") return { source, connectionId: a, externalId: b };
  if (source === "social") return { source: "social", accountId: a, conversationId: b };
  return null;
}

export interface MailParty {
  name: string | null;
  /** Email address, phone number or social handle. */
  address: string | null;
}

export interface MailThreadView {
  key: string;
  source: MailSource;
  /** The mailbox / channel it came through: "ana@acme.com", "SMS", "Instagram · @shop". */
  via: string;
  subject: string;
  from: MailParty;
  participants: string[];
  /** A short preview — shown, never stored for Gmail / Outlook. */
  snippet: string | null;
  lastMessageAt: string;
  messageCount: number | null;
  unread: boolean;
  archived: boolean;
  labels: string[];
  tags: string[];
  suggestedTags: string[];
  summary: string | null;
  /** sms | email for the CRM, the social platform for DMs. */
  channel: string | null;
  /** From a connector's labelled mock path (never in production). */
  mock: boolean;
  /** Can the Mail app archive / tag it (Gmail and Outlook cached threads). */
  organizable: boolean;
}

export interface MailMessageView {
  id: string;
  from: MailParty;
  to: string[];
  cc: string[];
  at: string;
  subject: string | null;
  body: string;
  direction: "inbound" | "outbound";
  /** CRM ledger state (queued for approval, sent, suppressed …). */
  status: string | null;
  channel: string | null;
}

/** "Ana Ruiz <ana@acme.com>" → { name, address }. */
export function parseParty(v: string | null | undefined): MailParty {
  const s = (v ?? "").trim();
  if (!s) return { name: null, address: null };
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1]!.trim() || null, address: m[2]!.trim().toLowerCase() };
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { name: null, address: s.toLowerCase() };
  return { name: s, address: null };
}

/**
 * Merge per-source lists into one inbox: newest first (ties by key, so the
 * order is stable), one row per key (the first list wins), capped. PURE.
 */
export function mergeThreads(lists: readonly (readonly MailThreadView[])[], limit = 100): MailThreadView[] {
  const seen = new Set<string>();
  const out: MailThreadView[] = [];
  for (const list of lists) {
    for (const t of list) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      out.push(t);
    }
  }
  out.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || a.key.localeCompare(b.key));
  return out.slice(0, limit);
}

export const MAIL_FOLDERS = ["inbox", "unread", "archived"] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

/** Does a thread belong in a folder? (PURE) */
export function inFolder(t: Pick<MailThreadView, "archived" | "unread">, folder: MailFolder): boolean {
  if (folder === "archived") return t.archived;
  if (folder === "unread") return !t.archived && t.unread;
  return !t.archived;
}

/** Case-insensitive text match over subject, people, snippet and tags (PURE). */
export function matchesQuery(t: MailThreadView, q: string | null | undefined): boolean {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return true;
  const hay = [t.subject, t.from.name, t.from.address, t.snippet, t.via, ...t.participants, ...t.tags, ...t.labels].filter(Boolean).join(" ").toLowerCase();
  return needle.split(/\s+/).every((w) => hay.includes(w));
}

/** Labels the person can apply (ShapesOS tags): short, lower-case, no punctuation soup. */
export function normalizeTag(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s+/g, " ").slice(0, 40);
  return s || null;
}

/** Group Outlook messages (one row per message) into conversations, newest message first. PURE. */
export function groupByConversation<M extends { id: string; conversationId: string | null; receivedAt: string | null; subject: string; from: string | null; isRead: boolean; preview?: string; mock?: boolean }>(
  messages: readonly M[],
): { conversationId: string; subject: string; from: string | null; lastMessageAt: string; messageCount: number; unread: boolean; latestMessageId: string; preview: string; participants: string[] }[] {
  const by = new Map<string, M[]>();
  for (const m of messages) {
    const k = m.conversationId ?? m.id;
    const list = by.get(k);
    if (list) list.push(m);
    else by.set(k, [m]);
  }
  return [...by.entries()]
    .map(([conversationId, list]) => {
      const sorted = [...list].sort((a, b) => String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? "")));
      const latest = sorted[0]!;
      return {
        conversationId,
        subject: sorted[sorted.length - 1]!.subject || latest.subject,
        from: latest.from,
        lastMessageAt: latest.receivedAt ?? new Date(0).toISOString(),
        messageCount: list.length,
        unread: list.some((m) => !m.isRead),
        latestMessageId: latest.id,
        preview: latest.preview ?? "",
        participants: [...new Set(list.map((m) => (m.from ?? "").toLowerCase()).filter(Boolean))],
      };
    })
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
}
