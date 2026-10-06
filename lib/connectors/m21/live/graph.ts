// ShapesOS — Phase 11 (conncore): Microsoft Graph v1.0 mail + calendar (live).
//
// Mail (connector "outlook"; scopes Mail.Read, Mail.Send, User.Read):
//   GET  /me                                  → liveness + own address
//   GET  /me/messages?$top&$select&$orderby (or $search)  → list_messages
//   GET  /me/messages/{id}?$select=…          → get_message (body as text)
//   POST /me/sendMail { message, saveToSentItems }        → 202
//   POST /me/messages/{id}/reply | replyAll { comment }   → 202
// Calendar (connector "outlook-calendar"; scopes Calendars.ReadWrite, User.Read):
//   GET   /me/calendarView?startDateTime&endDateTime      → list_events
//   POST  /me/events                                      → create_event
//   PATCH /me/events/{id}                                 → update_event
// Docs: https://learn.microsoft.com/graph/api/user-sendmail
//       https://learn.microsoft.com/graph/api/message-reply
//       https://learn.microsoft.com/graph/api/user-post-events
//       https://learn.microsoft.com/graph/api/event-update
//
// Writes are never retried on 5xx/network errors (no double sends or
// duplicate events); liveRequest still refreshes once on 401. Graph errors
// arrive as { error: { code, message } } — the default classifier reads them.

import { liveRequest, type LiveDeps, type TokenSource } from "./http";
import { parseRecipients } from "./mime";

export const GRAPH_API = "https://graph.microsoft.com/v1.0";
const PROVIDER = "Microsoft Graph";
const MAX_BODY = 200_000;

const writeDeps = (deps: LiveDeps): LiveDeps => ({ ...deps, maxRetries: 0 });

function requiredText(v: unknown, field: string, max = MAX_BODY): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} is required.`);
  return v.length > max ? v.slice(0, max) : v;
}

const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export interface GraphMessageSummary {
  id: string;
  subject: string;
  from: string | null;
  receivedAt: string | null;
  preview: string;
  conversationId: string | null;
  isRead: boolean;
}

interface RawMessage {
  id?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  bodyPreview?: string;
  conversationId?: string;
  isRead?: boolean;
  body?: { contentType?: string; content?: string };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
}

function summary(m: RawMessage): GraphMessageSummary {
  return {
    id: String(m.id ?? ""),
    subject: String(m.subject ?? ""),
    from: m.from?.emailAddress?.address ?? null,
    receivedAt: m.receivedDateTime ?? null,
    preview: String(m.bodyPreview ?? "").slice(0, 300),
    conversationId: m.conversationId ?? null,
    isRead: m.isRead === true,
  };
}

export async function graphMe(auth: TokenSource, deps: LiveDeps = {}): Promise<{ email: string; name: string | null }> {
  const me = await liveRequest<{ mail?: string; userPrincipalName?: string; displayName?: string }>(
    { provider: PROVIDER, url: `${GRAPH_API}/me`, query: { $select: "mail,userPrincipalName,displayName" }, auth },
    deps,
  );
  return { email: String(me?.mail ?? me?.userPrincipalName ?? ""), name: me?.displayName ?? null };
}

export async function graphListMessages(
  auth: TokenSource,
  opts: { search?: string | null; top?: number; unreadOnly?: boolean },
  deps: LiveDeps = {},
): Promise<GraphMessageSummary[]> {
  const top = Math.min(Math.max(Math.floor(opts.top ?? 25), 1), 50);
  const query: Record<string, string | number> = {
    $top: top,
    $select: "id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead",
  };
  const search = (opts.search ?? "").replace(/"/g, "").trim();
  // $search can't be combined with $orderby (Graph returns relevance order).
  if (search) query.$search = `"${search.slice(0, 200)}"`;
  else query.$orderby = "receivedDateTime desc";
  if (opts.unreadOnly && !search) query.$filter = "isRead eq false";
  const res = await liveRequest<{ value?: RawMessage[] }>(
    { provider: PROVIDER, url: `${GRAPH_API}/me/messages`, query, auth },
    deps,
  );
  return (res?.value ?? []).map(summary);
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export async function graphGetMessage(
  auth: TokenSource,
  id: string,
  deps: LiveDeps = {},
): Promise<GraphMessageSummary & { to: string[]; bodyText: string }> {
  if (!/^[A-Za-z0-9=_+\-/]{8,400}$/.test(id)) throw new Error("messageId must be a Graph message id.");
  const m = await liveRequest<RawMessage>(
    {
      provider: PROVIDER,
      url: `${GRAPH_API}/me/messages/${encodeURIComponent(id)}`,
      query: { $select: "id,subject,from,toRecipients,receivedDateTime,bodyPreview,conversationId,isRead,body" },
      // Plain text body from Graph itself where it can.
      headers: { Prefer: 'outlook.body-content-type="text"' },
      auth,
    },
    deps,
  );
  const content = String(m?.body?.content ?? "");
  const bodyText = (m?.body?.contentType ?? "").toLowerCase() === "html" ? htmlToText(content) : content;
  return {
    ...summary(m ?? {}),
    to: (m?.toRecipients ?? []).map((r) => String(r.emailAddress?.address ?? "")).filter(Boolean),
    bodyText: bodyText.slice(0, 20_000),
  };
}

export async function graphSendMail(
  auth: TokenSource,
  input: { to: unknown; cc?: unknown; bcc?: unknown; subject: unknown; body: unknown; html?: unknown },
  deps: LiveDeps = {},
): Promise<{ sent: true; to: string[] }> {
  const to = parseRecipients(input.to, "to");
  if (to.length === 0) throw new Error("to is required.");
  const html = typeof input.html === "string" && input.html.trim() ? input.html.slice(0, MAX_BODY) : null;
  await liveRequest(
    {
      provider: PROVIDER,
      url: `${GRAPH_API}/me/sendMail`,
      method: "POST",
      json: {
        message: {
          subject: requiredText(input.subject, "subject", 998).replace(/[\r\n]+/g, " "),
          body: html ? { contentType: "HTML", content: html } : { contentType: "Text", content: requiredText(input.body, "body") },
          toRecipients: recipients(to),
          ccRecipients: recipients(parseRecipients(input.cc, "cc")),
          bccRecipients: recipients(parseRecipients(input.bcc, "bcc")),
        },
        saveToSentItems: true,
      },
      auth,
    },
    writeDeps(deps),
  );
  return { sent: true, to };
}

export async function graphReply(
  auth: TokenSource,
  input: { messageId: unknown; body: unknown; replyAll?: unknown },
  deps: LiveDeps = {},
): Promise<{ sent: true; replyAll: boolean }> {
  const id = typeof input.messageId === "string" ? input.messageId.trim() : "";
  if (!/^[A-Za-z0-9=_+\-/]{8,400}$/.test(id)) throw new Error("messageId must be a Graph message id.");
  const replyAll = input.replyAll === true || input.replyAll === "true";
  await liveRequest(
    {
      provider: PROVIDER,
      url: `${GRAPH_API}/me/messages/${encodeURIComponent(id)}/${replyAll ? "replyAll" : "reply"}`,
      method: "POST",
      json: { comment: requiredText(input.body, "body") },
      auth,
    },
    writeDeps(deps),
  );
  return { sent: true, replyAll };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEventSummary {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  timeZone: string | null;
  location: string | null;
  attendees: string[];
  url: string | null;
}

interface RawGraphEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  webLink?: string;
}

function graphEvent(e: RawGraphEvent): CalendarEventSummary {
  return {
    id: String(e.id ?? ""),
    title: String(e.subject ?? ""),
    start: e.start?.dateTime ?? null,
    end: e.end?.dateTime ?? null,
    timeZone: e.start?.timeZone ?? null,
    location: e.location?.displayName || null,
    attendees: (e.attendees ?? []).map((a) => String(a.emailAddress?.address ?? "")).filter(Boolean),
    url: e.webLink ?? null,
  };
}

/** Validated event fields shared by Google and Graph writes. */
export interface EventFields {
  title?: string;
  description?: string;
  /** ISO local date-time "2026-10-12T15:00:00" (or with offset). */
  start?: string;
  end?: string;
  timeZone?: string;
  location?: string;
  attendees?: string[];
}

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?$/;
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){0,2}$|^UTC$/;

/** Parse tool args into event fields. `requireCore` for creates. PURE. */
export function parseEventArgs(args: Record<string, unknown>, requireCore: boolean): EventFields {
  const out: EventFields = {};
  const str = (k: string, max: number) => {
    const v = args[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new Error(`${k} must be text.`);
    return v.replace(/[\r\n]+/g, k === "description" ? "\n" : " ").slice(0, max);
  };
  out.title = str("title", 500);
  out.description = str("description", 8000);
  out.location = str("location", 500);
  out.start = str("start", 40);
  out.end = str("end", 40);
  out.timeZone = str("timeZone", 64);
  for (const k of ["start", "end"] as const) {
    if (out[k] && !DATE_TIME_RE.test(out[k] as string)) throw new Error(`${k} must be an ISO date-time like 2026-10-12T15:00:00.`);
  }
  if (out.timeZone && !TZ_RE.test(out.timeZone)) throw new Error("timeZone must be an IANA time zone like Europe/London.");
  if (args.attendees !== undefined && args.attendees !== null && args.attendees !== "") {
    out.attendees = parseRecipients(args.attendees, "attendees");
  }
  if (out.start && out.end && Date.parse(out.end) <= Date.parse(out.start) && !Number.isNaN(Date.parse(out.start))) {
    throw new Error("end must be after start.");
  }
  if (requireCore) {
    if (!out.title) throw new Error("title is required.");
    if (!out.start || !out.end) throw new Error("start and end are required.");
  }
  return out;
}

const hasOffset = (s: string) => /(Z|[+-]\d{2}:\d{2})$/.test(s);

function graphEventBody(f: EventFields): Record<string, unknown> {
  const tz = f.timeZone ?? "UTC";
  // Graph wants a local dateTime + timeZone; an offset date-time is normalized to UTC.
  const dt = (s: string) => (hasOffset(s) ? { dateTime: new Date(s).toISOString().replace(/Z$/, ""), timeZone: "UTC" } : { dateTime: s, timeZone: tz });
  const body: Record<string, unknown> = {};
  if (f.title !== undefined) body.subject = f.title;
  if (f.description !== undefined) body.body = { contentType: "Text", content: f.description };
  if (f.start) body.start = dt(f.start);
  if (f.end) body.end = dt(f.end);
  if (f.location !== undefined) body.location = { displayName: f.location };
  if (f.attendees) body.attendees = f.attendees.map((address) => ({ emailAddress: { address }, type: "required" }));
  return body;
}

export async function graphListEvents(
  auth: TokenSource,
  opts: { from: string; to: string; top?: number },
  deps: LiveDeps = {},
): Promise<CalendarEventSummary[]> {
  const res = await liveRequest<{ value?: RawGraphEvent[] }>(
    {
      provider: PROVIDER,
      url: `${GRAPH_API}/me/calendarView`,
      query: {
        startDateTime: opts.from,
        endDateTime: opts.to,
        $top: Math.min(Math.max(Math.floor(opts.top ?? 50), 1), 100),
        $select: "id,subject,start,end,location,attendees,webLink",
        $orderby: "start/dateTime",
      },
      auth,
    },
    deps,
  );
  return (res?.value ?? []).map(graphEvent);
}

export async function graphCreateEvent(auth: TokenSource, f: EventFields, deps: LiveDeps = {}): Promise<CalendarEventSummary> {
  const e = await liveRequest<RawGraphEvent>(
    { provider: PROVIDER, url: `${GRAPH_API}/me/events`, method: "POST", json: graphEventBody(f), auth },
    writeDeps(deps),
  );
  return graphEvent(e ?? {});
}

export async function graphUpdateEvent(auth: TokenSource, id: string, f: EventFields, deps: LiveDeps = {}): Promise<CalendarEventSummary> {
  if (!/^[A-Za-z0-9=_+\-/]{8,400}$/.test(id)) throw new Error("eventId must be a Graph event id.");
  const body = graphEventBody(f);
  if (Object.keys(body).length === 0) throw new Error("Nothing to update — pass at least one field.");
  const e = await liveRequest<RawGraphEvent>(
    { provider: PROVIDER, url: `${GRAPH_API}/me/events/${encodeURIComponent(id)}`, method: "PATCH", json: body, auth },
    writeDeps(deps),
  );
  return graphEvent(e ?? {});
}

// ---------------------------------------------------------------------------
// Phase 18.2 (WS=comms): one conversation's messages for the Mail app's
// thread view (bodies as text; returned for the open thread, never stored).
//   GET /me/messages?$filter=conversationId eq '<id>'   (scope Mail.Read)
// Ordered oldest first client-side (Graph refuses some filter + orderby mixes).
// ---------------------------------------------------------------------------

export async function graphListConversation(
  auth: TokenSource,
  conversationId: string,
  deps: LiveDeps = {},
): Promise<(GraphMessageSummary & { to: string[]; cc: string[]; bodyText: string })[]> {
  if (!/^[A-Za-z0-9=_+\-/]{8,400}$/.test(conversationId)) throw new Error("conversationId must be a Graph conversation id.");
  const res = await liveRequest<{ value?: (RawMessage & { ccRecipients?: { emailAddress?: { address?: string } }[] })[] }>(
    {
      provider: PROVIDER,
      url: `${GRAPH_API}/me/messages`,
      query: {
        $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
        $top: 50,
        $select: "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,conversationId,isRead,body",
      },
      headers: { Prefer: 'outlook.body-content-type="text"' },
      auth,
    },
    deps,
  );
  return (res?.value ?? [])
    .map((m) => {
      const content = String(m.body?.content ?? "");
      const bodyText = (m.body?.contentType ?? "").toLowerCase() === "html" ? htmlToText(content) : content;
      return {
        ...summary(m),
        to: (m.toRecipients ?? []).map((r) => String(r.emailAddress?.address ?? "")).filter(Boolean),
        cc: (m.ccRecipients ?? []).map((r) => String(r.emailAddress?.address ?? "")).filter(Boolean),
        bodyText: bodyText.slice(0, 50_000),
      };
    })
    .sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")));
}
