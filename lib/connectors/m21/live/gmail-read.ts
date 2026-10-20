// ShapesOS — Phase 18.2 (WS=comms): Gmail inbox reads for the Mail app (live).
//
//   GET https://gmail.googleapis.com/gmail/v1/users/me/threads
//       ?q=…&labelIds=…&maxResults=…&pageToken=…        → thread ids
//   GET …/threads/{id}?format=metadata&metadataHeaders=…   → headers per message
//   GET …/threads/{id}?format=full                        → bodies (on open only)
// Scope: gmail.readonly (already requested by the Gmail connector).
// Docs: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads
//
// Thread HEADERS are what the Mail app caches; bodies are returned for the
// thread being opened and never stored. Reads only — nothing here changes
// the mailbox (read / archive state is the Mail app's own, see
// lib/comms/mail). Reads retry like every live read (liveRequest).

import { liveRequest, type LiveDeps, type TokenSource } from "./http";
import { GMAIL_API } from "./gmail";

const PROVIDER = "Gmail";
const MAX_THREADS = 50;

interface Header {
  name: string;
  value: string;
}

interface RawPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: RawPart[];
  headers?: Header[];
}

interface RawMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: RawPart;
}

interface RawThread {
  id?: string;
  snippet?: string;
  messages?: RawMessage[];
}

export interface GmailThreadSummary {
  id: string;
  subject: string;
  from: string;
  participants: string[];
  lastMessageAt: string;
  messageCount: number;
  unread: boolean;
  labels: string[];
  latestMessageId: string | null;
  /** Gmail's own short preview — shown, never stored. */
  snippet: string;
}

export interface GmailMessageView {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  subject: string;
  bodyText: string;
  labels: string[];
}

function header(headers: Header[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
function emails(v: string): string[] {
  return [...new Set([...v.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()))];
}

function decodeB64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** HTML → readable text (no markup ever reaches the UI). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The message's text: the first text/plain part, else text/html as text. */
export function messageText(part: RawPart | undefined): string {
  if (!part) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: RawPart) => {
    if (p.filename) return; // attachments are not bodies
    if (p.mimeType === "text/plain" && p.body?.data) plain.push(decodeB64Url(p.body.data));
    else if (p.mimeType === "text/html" && p.body?.data) html.push(decodeB64Url(p.body.data));
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  const text = plain.length ? plain.join("\n") : htmlToText(html.join("\n"));
  return text.slice(0, 200_000);
}

function dateOf(m: RawMessage): string {
  const ms = Number(m.internalDate);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  const d = Date.parse(header(m.payload?.headers, "Date"));
  return Number.isNaN(d) ? new Date(0).toISOString() : new Date(d).toISOString();
}

/** One thread's header summary from its messages (pure). */
export function summarizeThread(t: RawThread): GmailThreadSummary | null {
  const msgs = t.messages ?? [];
  if (!t.id || !msgs.length) return null;
  const sorted = [...msgs].sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const participants = new Set<string>();
  for (const m of sorted) {
    for (const h of ["From", "To", "Cc"]) for (const e of emails(header(m.payload?.headers, h))) participants.add(e);
  }
  const labels = new Set<string>();
  for (const m of sorted) for (const l of m.labelIds ?? []) labels.add(l);
  return {
    id: t.id,
    subject: header(first.payload?.headers, "Subject").slice(0, 500),
    from: header(last.payload?.headers, "From").slice(0, 300),
    participants: [...participants].slice(0, 50),
    lastMessageAt: dateOf(last),
    messageCount: sorted.length,
    unread: sorted.some((m) => (m.labelIds ?? []).includes("UNREAD")),
    labels: [...labels].slice(0, 30),
    latestMessageId: last.id ?? null,
    snippet: (last.snippet ?? t.snippet ?? "").slice(0, 300),
  };
}

const METADATA = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date";

/** Recent threads (newest first) with their header summaries. */
export async function gmailListThreads(
  auth: TokenSource,
  opts: { q?: string | null; labelIds?: string | null; max?: number; pageToken?: string | null },
  deps: LiveDeps = {},
): Promise<{ threads: GmailThreadSummary[]; nextPageToken: string | null }> {
  const max = Math.min(Math.max(Math.floor(opts.max ?? 25), 1), MAX_THREADS);
  const list = await liveRequest<{ threads?: { id: string }[]; nextPageToken?: string }>(
    {
      provider: PROVIDER,
      url: `${GMAIL_API}/threads`,
      query: { q: opts.q ?? undefined, labelIds: opts.labelIds ?? undefined, maxResults: max, pageToken: opts.pageToken ?? undefined },
      auth,
    },
    deps,
  );
  const threads: GmailThreadSummary[] = [];
  for (const t of list?.threads ?? []) {
    const raw = await liveRequest<RawThread>({ provider: PROVIDER, url: `${GMAIL_API}/threads/${encodeURIComponent(t.id)}?${METADATA}`, auth }, deps);
    const s = summarizeThread(raw ?? {});
    if (s) threads.push(s);
  }
  return { threads, nextPageToken: list?.nextPageToken ?? null };
}

/** One thread with every message's text (for the thread being opened; never stored). */
export async function gmailGetThread(auth: TokenSource, threadId: string, deps: LiveDeps = {}): Promise<{ id: string; messages: GmailMessageView[] }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(threadId)) throw new Error("threadId must be a Gmail thread id.");
  const raw = await liveRequest<RawThread>({ provider: PROVIDER, url: `${GMAIL_API}/threads/${encodeURIComponent(threadId)}`, query: { format: "full" }, auth }, deps);
  const messages = [...(raw?.messages ?? [])]
    .sort((a, b) => dateOf(a).localeCompare(dateOf(b)))
    .map((m) => {
      const h = m.payload?.headers;
      return {
        id: String(m.id ?? ""),
        from: header(h, "From"),
        to: emails(header(h, "To")),
        cc: emails(header(h, "Cc")),
        date: dateOf(m),
        subject: header(h, "Subject"),
        bodyText: messageText(m.payload),
        labels: m.labelIds ?? [],
      };
    });
  return { id: threadId, messages };
}
