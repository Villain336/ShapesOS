// ShapesOS — Phase 18.2 (WS=comms): the communication apps as agent tools.
//
// Agents are first-class users of every app: the same reads and writes a
// person makes in Mail, Calendar, Contacts, Messages, Meet and Reminders, in
// the ONE tool registry (lib/chat/tools.ts spreads these in), so every call
// goes through executeTool — grant, role, the confirmation gate with the
// per-agent auto rules, audit, run timeline. Tiers are deliberate (the
// action each non-safe tool stands for is in COMMS_TOOL_ACTION; the tier is
// evaluated by lib/orchestrator/authority.ts from it AND "<name>: <description>",
// so no description here uses a Tier-3 verb by accident):
//
//   tool                kind     action                 tier
//   list_reminders      safe     —                      0 (read)
//   create_reminder     publish  create_reminder        1 (personal, auto-able by rule)
//   complete_reminder   publish  complete_reminder      1 (personal, auto-able by rule)
//   find_contact        safe     —                      0 (read the address book)
//   suggest_merge       safe     —                      0 (only PROPOSES: a pending suggestion a person decides)
//   confirm_merge       publish  confirm_contact_merge  1 (merges two contacts; asks unless a rule says auto)
//   calendar_list_events            safe     —                       0
//   calendar_find_time              safe     —                       0 (proposes slots, books nothing)
//   calendar_create_event_google    publish  write_google_calendar   2 (the connector's own action)
//   calendar_create_event_outlook   publish  write_outlook_calendar  2 (the connector's own action)
//   mail_list_threads   safe     —                      0 (the person's inbox: own mailboxes, CRM, social DMs)
//   mail_read_thread    safe     —                      0 (never marks anything read)
//   mail_label_thread   safe     —                      0 (stores a summary + SUGGESTED labels only)
//   mail_draft_reply    publish  draft_mail_reply       0 (a draft; nothing is sent)
//   mail_send           publish  send_outreach_email    2 (the existing email send action: asks unless a rule says auto)
//   social_send_dm      publish  send_social_dm         2 (a DM to a customer: asks unless a rule says auto)
//
// (Mail, Calendar, Contacts, Messages and Meet tools are added below as each
// app lands; the full table is in the Phase 18.2 report.)
//
// Implementations import their services lazily so this module stays light
// for lib/chat/tools.ts.

import type { ToolDef, ToolResult } from "@/lib/chat/tools";
import type { ToolGroup } from "@/lib/agents/grants";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function parseWhen(v: unknown): Date | null | "invalid" {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

async function scoped<T>(workspaceId: string, fn: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
  return withWorkspaceScope(workspaceId, (tx) => fn(tx as import("@prisma/client").Prisma.TransactionClient));
}

// ---------------------------------------------------------------------------
// Reminders (lib/comms/reminders.ts): the person's own to-dos.
// ---------------------------------------------------------------------------

const list_reminders: ToolDef = {
  name: "list_reminders",
  description: "List the person's own open reminders (title, due time, repeat) from the Reminders app, soonest first.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { includeDone: { type: "boolean", description: "Also list the recently done ones." } } },
  async execute(ctx, args): Promise<ToolResult> {
    const { listReminders } = await import("./reminders");
    const rows = await scoped(ctx.workspaceId, (tx) => listReminders(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, includeDone: args.includeDone === true, limit: 50 }));
    return { summary: `${rows.length} reminder${rows.length === 1 ? "" : "s"}`, details: rows };
  },
};

const create_reminder: ToolDef = {
  name: "create_reminder",
  description:
    "Add a reminder to the person's own Reminders list (a personal to-do with an optional due time and a daily/weekly/monthly repeat). They get a notification when it is due.",
  kind: "publish",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "What to remember (one line)." },
      dueAt: { type: "string", description: "Due time, ISO 8601 with an offset (e.g. 2026-10-16T09:00:00-04:00). Optional." },
      repeat: { type: "string", description: "daily | weekly | monthly (needs dueAt). Optional." },
      notes: { type: "string", description: "Optional notes." },
    },
    required: ["title"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const { createReminder, isRepeatRule } = await import("./reminders");
    const title = str(args.title);
    if (!title) return { summary: "A reminder needs a title." };
    const due = parseWhen(args.dueAt);
    if (due === "invalid") return { summary: `"${String(args.dueAt)}" is not a date-time — use ISO 8601 with an offset.` };
    const repeat = str(args.repeat);
    if (repeat && !isRepeatRule(repeat)) return { summary: "repeat must be daily, weekly or monthly." };
    const r = await scoped(ctx.workspaceId, (tx) =>
      createReminder(tx, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        title,
        notes: str(args.notes) ?? null,
        dueAt: due,
        repeat: (repeat as "daily" | "weekly" | "monthly" | undefined) ?? null,
        sourceRef: str(args.sourceRef) ?? null,
      }),
    );
    return { summary: `Reminder added: "${r.title}"${r.dueAt ? ` (due ${r.dueAt})` : ""}`, details: { reminder: r, href: `/dashboard/reminders?reminder=${r.id}` } };
  },
};

const complete_reminder: ToolDef = {
  name: "complete_reminder",
  description: "Mark one of the person's own reminders done (a repeating one moves on to its next occurrence).",
  kind: "publish",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { reminderId: { type: "string", description: "The reminder id (from list_reminders)." } }, required: ["reminderId"] },
  async execute(ctx, args): Promise<ToolResult> {
    const { updateReminder } = await import("./reminders");
    const id = str(args.reminderId);
    if (!id) return { summary: "Which reminder? Pass reminderId from list_reminders." };
    const { getUserPreferences } = await import("@/lib/preferences");
    const tz = (await getUserPreferences(ctx.userId).catch(() => null))?.timeZone ?? "UTC";
    const r = await scoped(ctx.workspaceId, (tx) => updateReminder(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, id, patch: { done: true }, timeZone: tz }));
    return { summary: r.done ? `Done: "${r.title}"` : `Done for now: "${r.title}" — next ${r.dueAt}`, details: { reminder: r } };
  },
};


// ---------------------------------------------------------------------------
// Contacts (lib/comms/contacts): the address book over the four people stores.
// ---------------------------------------------------------------------------

function parseRecordRef(v: unknown): { kind: import("./contacts/match").ContactRecordKind; id: string } | null {
  const s = str(v);
  if (!s) return null;
  const i = s.indexOf(":");
  if (i <= 0) return null;
  const kind = s.slice(0, i);
  const id = s.slice(i + 1).trim();
  const kinds = ["lead", "ops_contact", "connector_person", "funding_contact"] as const;
  return (kinds as readonly string[]).includes(kind) && id ? { kind: kind as (typeof kinds)[number], id: id.slice(0, 64) } : null;
}

const find_contact: ToolDef = {
  name: "find_contact",
  description:
    "Find people in the Contacts address book (one entry per person across CRM leads, Ops contacts, the Network and funding contacts) by name, email, phone or company. Returns each person's id, emails, phones, companies and linked records (kind:id).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Name, email, phone or company." }, limit: { type: "number", description: "Max people (default 10)." } },
    required: ["query"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const q = str(args.query);
    if (!q) return { summary: "What should I look for? Pass a name, email, phone or company." };
    const { findContacts } = await import("./contacts/store");
    const people = await scoped(ctx.workspaceId, (tx) => findContacts(tx, ctx.workspaceId, q, Math.min(Math.max(Number(args.limit) || 10, 1), 25)));
    const details = await scoped(ctx.workspaceId, async (tx) =>
      Promise.all(
        people.map(async (p) => ({
          ...p,
          records: (await tx.contactIdentityLink.findMany({ where: { workspaceId: ctx.workspaceId, identityId: p.id }, select: { recordKind: true, recordId: true } })).map((l) => `${l.recordKind}:${l.recordId}`),
          href: `/dashboard/contacts/${p.id}`,
        })),
      ),
    );
    return { summary: `${people.length} ${people.length === 1 ? "person" : "people"} match "${q}"`, details };
  },
};

const suggest_merge: ToolDef = {
  name: "suggest_merge",
  description:
    "Suggest that records are the same person, for a person to confirm in Contacts (this never merges anything). Either pass two records (recordA / recordB as kind:id, e.g. lead:abc and ops_contact:xyz), or a contactId to look for other records of that person. A pair someone marked as different people is never suggested again.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      recordA: { type: "string", description: "A record as kind:id (kinds: lead, ops_contact, connector_person, funding_contact)." },
      recordB: { type: "string", description: "The other record as kind:id." },
      contactId: { type: "string", description: "Or: a Contacts person id (from find_contact) to look for duplicates of." },
    },
  },
  async execute(ctx, args): Promise<ToolResult> {
    const store = await import("./contacts/store");
    const a = parseRecordRef(args.recordA);
    const b = parseRecordRef(args.recordB);
    if (a && b) {
      const out = await scoped(ctx.workspaceId, (tx) => store.proposeMerge(tx, { workspaceId: ctx.workspaceId, a, b, via: "agent" }));
      const said: Record<typeof out.outcome, string> = {
        proposed: "Suggested — a person confirms it in Contacts → Merge suggestions.",
        exists: "Already suggested and waiting for a person.",
        already_merged: "These records are already one contact.",
        previously_rejected: "A person said these are different people, so it was not suggested.",
      };
      return { summary: said[out.outcome], details: { outcome: out.outcome, suggestion: out.suggestion, href: "/dashboard/contacts?tab=suggestions" } };
    }
    const contactId = str(args.contactId);
    if (!contactId) return { summary: "Pass recordA and recordB (kind:id), or a contactId." };
    const { compareRecords, SUGGEST_THRESHOLD, recordKey } = await import("./contacts/match");
    const result = await scoped(ctx.workspaceId, async (tx) => {
      const links = await tx.contactIdentityLink.findMany({ where: { workspaceId: ctx.workspaceId, identityId: contactId }, select: { recordKind: true, recordId: true } });
      if (!links.length) return null;
      const all = await store.loadPersonRecords(tx, ctx.workspaceId);
      const mine = new Set(links.map((l) => `${l.recordKind}:${l.recordId}`));
      const own = all.filter((r) => mine.has(recordKey(r)));
      const scored: { a: (typeof all)[number]; b: (typeof all)[number]; score: number }[] = [];
      for (const other of all) {
        if (mine.has(recordKey(other))) continue;
        let best: { a: (typeof all)[number]; score: number } | null = null;
        for (const r of own) {
          const ev = compareRecords(r, other);
          if (ev.score >= SUGGEST_THRESHOLD && (!best || ev.score > best.score)) best = { a: r, score: ev.score };
        }
        if (best) scored.push({ a: best.a, b: other, score: best.score });
      }
      scored.sort((x, y) => y.score - x.score);
      const outcomes = [];
      for (const s of scored.slice(0, 5)) {
        const out = await store.proposeMerge(tx, { workspaceId: ctx.workspaceId, a: { kind: s.a.kind, id: s.a.id }, b: { kind: s.b.kind, id: s.b.id }, via: "agent" });
        outcomes.push({ record: `${s.b.kind}:${s.b.id}`, name: s.b.name, score: s.score, outcome: out.outcome });
      }
      return outcomes;
    });
    if (!result) return { summary: `No contact ${contactId} in this workspace.` };
    const proposed = result.filter((r) => r.outcome === "proposed" || r.outcome === "exists").length;
    return {
      summary: proposed ? `${proposed} possible duplicate${proposed === 1 ? "" : "s"} suggested for a person to confirm.` : "No likely duplicates found.",
      details: { candidates: result, href: "/dashboard/contacts?tab=suggestions" },
    };
  },
};

const confirm_merge: ToolDef = {
  name: "confirm_merge",
  description: "Confirm a pending Contacts merge suggestion (by id): the two people become one contact card; each record stays in its own app. Asks first unless a rule allows it.",
  kind: "publish",
  minRole: "editor",
  argsSchema: { type: "object", properties: { suggestionId: { type: "string", description: "The pending suggestion's id (from suggest_merge or Contacts)." } }, required: ["suggestionId"] },
  async execute(ctx, args): Promise<ToolResult> {
    const id = str(args.suggestionId);
    if (!id) return { summary: "Which suggestion? Pass suggestionId." };
    const { confirmSuggestion } = await import("./contacts/store");
    // Who confirmed: the person ("yes") — or the agent, when a rule ran it without asking.
    const by = ctx.confirmed ? ctx.userId : `agent:${ctx.agentKey ?? "lead"}`;
    const out = await scoped(ctx.workspaceId, (tx) => confirmSuggestion(tx, { workspaceId: ctx.workspaceId, suggestionId: id, userId: by }));
    return { summary: `Merged into one contact.`, details: { identityId: out.identityId, href: `/dashboard/contacts/${out.identityId}` } };
  },
};

// ---------------------------------------------------------------------------
// Calendar (lib/comms/calendar): the member's own calendars + ShapesOS events.
// ---------------------------------------------------------------------------

async function memberTz(userId: string): Promise<string> {
  const { getUserPreferences } = await import("@/lib/preferences");
  return (await getUserPreferences(userId).catch(() => null))?.timeZone ?? "UTC";
}

const calendar_list_events: ToolDef = {
  name: "calendar_list_events",
  description:
    "List the person's calendar between two times: their connected Google / Outlook calendars, bookings, focus blocks, Ops events, scheduled social posts, reminders and calls (title, start, end, source, attendees).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: { from: { type: "string", description: "Window start, ISO 8601 (default now)." }, to: { type: "string", description: "Window end, ISO 8601 (default from + 7 days, max 31 days)." } },
  },
  async execute(ctx, args): Promise<ToolResult> {
    const from = parseWhen(args.from);
    const to = parseWhen(args.to);
    if (from === "invalid" || to === "invalid") return { summary: "from / to must be ISO 8601 date-times." };
    const start = from ?? new Date();
    const end = to ?? new Date(start.getTime() + 7 * 86_400_000);
    if (end <= start || end.getTime() - start.getTime() > 31 * 86_400_000) return { summary: "The window must be after from and at most 31 days." };
    const { loadCalendarEvents } = await import("./calendar/sources.server");
    const load = await loadCalendarEvents({ workspaceId: ctx.workspaceId, userId: ctx.userId, timeZone: await memberTz(ctx.userId) }, start, end);
    const events = load.events.slice(0, 100).map((e) => ({ id: e.id, source: e.source, title: e.title, start: e.start, end: e.end, attendees: e.attendees, mock: e.mock || undefined }));
    return {
      summary: `${load.events.length} event${load.events.length === 1 ? "" : "s"} (${load.timeZone})${load.errors.length ? `; ${load.errors.map((e) => `${e.source}: ${e.message}`).join("; ")}` : ""}`,
      details: { timeZone: load.timeZone, events, connectedCalendars: load.connections },
    };
  },
};

const calendar_find_time: ToolDef = {
  name: "calendar_find_time",
  description:
    "Find free slots for a meeting in the person's working hours (their time zone), around their connected calendars, bookings, focus blocks, calls and Ops events. Proposes slots only — booking one is a separate calendar_create_event_* call, which asks first.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      durationMin: { type: "number", description: "Meeting length in minutes (default 30)." },
      from: { type: "string", description: "Search from, ISO 8601 (default now)." },
      to: { type: "string", description: "Search until, ISO 8601 (default 7 days later, max 31 days)." },
      max: { type: "number", description: "How many slots (default 5)." },
    },
  },
  async execute(ctx, args): Promise<ToolResult> {
    const from = parseWhen(args.from);
    const to = parseWhen(args.to);
    if (from === "invalid" || to === "invalid") return { summary: "from / to must be ISO 8601 date-times." };
    const now = new Date();
    const start = from ?? now;
    const end = to ?? new Date(start.getTime() + 7 * 86_400_000);
    if (end <= start || end.getTime() - start.getTime() > 31 * 86_400_000) return { summary: "The window must be after from and at most 31 days." };
    const tz = await memberTz(ctx.userId);
    const { busyIntervals } = await import("./calendar/sources.server");
    const { findSlots } = await import("./calendar/freebusy");
    const { busy, errors, connected } = await busyIntervals({ workspaceId: ctx.workspaceId, userId: ctx.userId, timeZone: tz }, start, end);
    const slots = findSlots({ busy, from: start, to: end, durationMin: Number(args.durationMin) || 30, timeZone: tz, max: Math.min(Math.max(Number(args.max) || 5, 1), 20), notBefore: new Date(now.getTime() + 15 * 60_000) });
    return {
      summary: `${slots.length} free slot${slots.length === 1 ? "" : "s"} (${tz}; ${connected} connected calendar${connected === 1 ? "" : "s"}${errors.length ? `, ${errors.length} could not be read` : ""})`,
      details: { timeZone: tz, slots: slots.map((x) => ({ start: x.start.toISOString(), end: x.end.toISOString() })), errors },
    };
  },
};

function calendarCreateTool(provider: "google" | "outlook"): ToolDef {
  const key = provider === "google" ? "google-calendar" : "outlook-calendar";
  const label = provider === "google" ? "Google Calendar" : "Outlook Calendar";
  return {
    name: `calendar_create_event_${provider}`,
    description: `Create an event on the person's own ${label} and invite attendees. Asks first unless a rule allows it.`,
    kind: "publish",
    minRole: "viewer",
    argsSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title." },
        start: { type: "string", description: "Start, ISO 8601 (with an offset, or a wall time plus timeZone)." },
        end: { type: "string", description: "End, ISO 8601." },
        timeZone: { type: "string", description: "IANA zone for wall times without an offset (default the person's zone)." },
        attendees: { type: "string", description: "Attendee emails, comma-separated." },
        description: { type: "string", description: "Event description." },
        location: { type: "string", description: "Location or call link." },
      },
      required: ["title", "start", "end"],
    },
    async execute(ctx, args): Promise<ToolResult> {
      const { personalConnections } = await import("./connectors.server");
      const { saveCalendarEvent } = await import("./calendar/write.server");
      const conn = (await personalConnections(ctx.workspaceId, ctx.userId, [key]))[0];
      if (!conn) return { summary: `${label} is not connected for this person. Connect it in Settings → Connectors.` };
      const fields = {
        title: str(args.title),
        start: str(args.start),
        end: str(args.end),
        timeZone: str(args.timeZone) ?? (await memberTz(ctx.userId)),
        attendees: str(args.attendees),
        description: str(args.description),
        location: str(args.location),
      };
      try {
        const out = await saveCalendarEvent({ workspaceId: ctx.workspaceId, userId: ctx.userId, connectionId: conn.id, fields, by: "agent" });
        return { summary: out.mock ? `MOCK — ${label} is not really connected; nothing was created.` : `Created "${fields.title}" on ${label}.`, details: out };
      } catch (err) {
        return { summary: err instanceof Error ? err.message : `${label} refused the event.` };
      }
    },
  };
}

const calendar_create_event_google = calendarCreateTool("google");
const calendar_create_event_outlook = calendarCreateTool("outlook");

// ---------------------------------------------------------------------------
// Mail (lib/comms/mail): the person's unified inbox — their own mailboxes,
// the CRM conversations and the workspace's social DMs.
// ---------------------------------------------------------------------------

function mailCtx(ctx: { workspaceId: string; userId: string; role: string }) {
  return { workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role as "viewer" | "editor" | "admin" | "owner" };
}

const mail_list_threads: ToolDef = {
  name: "mail_list_threads",
  description:
    "List the person's inbox in the Mail app: their own Gmail / Outlook, the CRM conversations (email and SMS with leads) and social DMs, newest first, with thread keys, subjects, senders, unread state and any summary.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      folder: { type: "string", description: "inbox (default) | unread | archived" },
      query: { type: "string", description: "Optional words to match (subject, people)." },
      source: { type: "string", description: "Optional: gmail | outlook | crm | social" },
      limit: { type: "number", description: "Max threads (default 20, max 50)." },
    },
  },
  async execute(ctx, args): Promise<ToolResult> {
    const { listMailbox } = await import("./mail/mailbox.server");
    const { isMailSource } = await import("./mail/types");
    const folder = args.folder === "unread" || args.folder === "archived" ? args.folder : "inbox";
    const source = isMailSource(args.source) ? args.source : null;
    const listing = await listMailbox(mailCtx(ctx), { folder, q: str(args.query) ?? null, source, limit: Math.min(Math.max(Number(args.limit) || 20, 1), 50) });
    const threads = listing.threads.map((t) => ({ key: t.key, source: t.source, via: t.via, subject: t.subject, from: t.from.name ?? t.from.address, at: t.lastMessageAt, unread: t.unread, summary: t.summary, mock: t.mock || undefined }));
    const errors = listing.sources.filter((s) => s.error).map((s) => `${s.source}: ${s.error}`);
    return { summary: `${threads.length} thread${threads.length === 1 ? "" : "s"}${errors.length ? ` (${errors.join("; ")})` : ""}`, details: { threads, sources: listing.sources } };
  },
};

const mail_read_thread: ToolDef = {
  name: "mail_read_thread",
  description: "Read one thread from the person's inbox by its key (from mail_list_threads): every message with sender, time and text. Reading never marks it read.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { key: { type: "string", description: "The thread key." } }, required: ["key"] },
  async execute(ctx, args): Promise<ToolResult> {
    const key = str(args.key);
    if (!key) return { summary: "Pass the thread key from mail_list_threads." };
    const { readMailThread } = await import("./mail/mailbox.server");
    const d = await readMailThread(mailCtx(ctx), key, { markRead: false });
    const messages = d.messages.slice(-15).map((m) => ({ from: m.from.name ?? m.from.address, direction: m.direction, at: m.at, text: m.body.slice(0, 4000) }));
    return { summary: `"${d.thread.subject}" — ${d.messages.length} message${d.messages.length === 1 ? "" : "s"}`, details: { thread: { key: d.thread.key, subject: d.thread.subject, via: d.thread.via, mock: d.thread.mock }, messages, reply: d.reply } };
  },
};

const mail_label_thread: ToolDef = {
  name: "mail_label_thread",
  description: "Save a short summary and 1-3 SUGGESTED labels on one of the person's Gmail / Outlook threads (the person accepts labels; nothing changes in the mailbox).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "The thread key (gmail:… or outlook:…)." },
      summary: { type: "string", description: "Two or three plain sentences." },
      labels: { type: "string", description: "Suggested labels, comma-separated (e.g. needs reply, billing)." },
    },
    required: ["key"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const { parseThreadKey, normalizeTag } = await import("./mail/types");
    const ref = parseThreadKey(args.key);
    if (!ref || (ref.source !== "gmail" && ref.source !== "outlook")) return { summary: "Only Gmail and Outlook threads take labels here." };
    const labels = (str(args.labels) ?? "").split(",").map(normalizeTag).filter((x): x is string => !!x).slice(0, 3);
    const summary = str(args.summary)?.slice(0, 1200) ?? null;
    const r = await scoped(ctx.workspaceId, (tx) =>
      tx.mailThreadCache.updateMany({
        where: { workspaceId: ctx.workspaceId, ownerUserId: ctx.userId, connectionId: ref.connectionId, externalId: ref.externalId },
        data: { suggestedTags: labels, ...(summary ? { summary, summarizedAt: new Date() } : {}) },
      }),
    );
    return { summary: r.count ? `Suggested ${labels.join(", ") || "no labels"}${summary ? " and saved a summary" : ""}.` : "That thread is not in the person's cached inbox (list it first)." };
  },
};

const mail_draft_reply: ToolDef = {
  name: "mail_draft_reply",
  description: "Draft a reply to a thread in the person's inbox and save it as a draft in Mail (nothing is sent; the person reviews and sends it).",
  kind: "publish",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: { key: { type: "string", description: "The thread key." }, instructions: { type: "string", description: "Optional: what the reply should say." } },
    required: ["key"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const key = str(args.key);
    if (!key) return { summary: "Pass the thread key." };
    const { draftReply } = await import("./mail/agent.server");
    const out = await draftReply(mailCtx(ctx), key, { instructions: str(args.instructions) ?? null, agentKey: ctx.agentKey ?? "drafter", runId: ctx.runId ?? null });
    return { summary: `Draft saved for "${out.draft.subject ?? key}"${out.mock ? " (MOCK model)" : ""} — review it in Mail.`, details: { draftId: out.draft.id, href: `/dashboard/mail?thread=${encodeURIComponent(key)}` } };
  },
};

const mail_send: ToolDef = {
  name: "mail_send",
  description:
    "Send email for the person: a reply in a thread from their inbox (Gmail, Outlook, or a CRM conversation by email / SMS), or a new email from one of their own mailboxes. Asks first unless a rule allows it.",
  kind: "publish",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Thread key to reply in (gmail:… / outlook:… / crm:…). Omit for a new email." },
      connectionId: { type: "string", description: "New email only: which of the person's mailboxes (from mail_list_threads sources)." },
      to: { type: "string", description: "New email: recipients, comma-separated." },
      subject: { type: "string", description: "Subject (new email / CRM email)." },
      body: { type: "string", description: "The message text." },
      channel: { type: "string", description: "CRM only: email | sms." },
      replyToMessageId: { type: "string", description: "Gmail / Outlook reply: the message id to answer (from mail_read_thread reply)." },
    },
    required: ["body"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const { sendMail } = await import("./mail/send.server");
    const key = str(args.key) ?? null;
    if (key?.startsWith("social:")) return { summary: "Use social_send_dm for social messages." };
    let replyTo = str(args.replyToMessageId) ?? null;
    if (key && !key.startsWith("crm:") && !replyTo) {
      const { readMailThread } = await import("./mail/mailbox.server");
      replyTo = (await readMailThread(mailCtx(ctx), key)).reply.replyToMessageId ?? null;
    }
    const out = await sendMail(
      { workspaceId: ctx.workspaceId, userId: ctx.userId, role: mailCtx(ctx).role, by: "agent" },
      { threadKey: key, connectionId: str(args.connectionId) ?? null, to: str(args.to) ?? null, subject: str(args.subject) ?? null, body: String(args.body ?? ""), channel: args.channel === "sms" ? "sms" : args.channel === "email" ? "email" : null, replyToMessageId: replyTo },
    );
    return { summary: out.outcome === "mock" ? (out.detail ?? "MOCK — nothing was sent.") : `${out.outcome === "queued" ? "Queued (waiting for its approval / quiet hours)" : out.outcome === "suppressed" ? `Not sent (${out.detail})` : "Sent"} via ${out.source}.`, details: out };
  },
};

const social_send_dm: ToolDef = {
  name: "social_send_dm",
  description: "Reply in a social DM conversation from the inbox (Instagram, Messenger, WhatsApp, X, Telegram …) on one of this workspace's own accounts. Asks first unless a rule allows it.",
  kind: "publish",
  minRole: "editor",
  argsSchema: { type: "object", properties: { key: { type: "string", description: "The social:… thread key." }, text: { type: "string", description: "The message." } }, required: ["key", "text"] },
  async execute(ctx, args): Promise<ToolResult> {
    const key = str(args.key);
    if (!key?.startsWith("social:")) return { summary: "Pass a social:… thread key from mail_list_threads." };
    const { sendMail } = await import("./mail/send.server");
    const out = await sendMail({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: mailCtx(ctx).role, by: "agent" }, { threadKey: key, body: String(args.text ?? ""), idempotencySeed: ctx.runId ?? null });
    return { summary: out.outcome === "mock" ? (out.detail ?? "MOCK — nothing reached a platform.") : "Sent.", details: out };
  },
};

export const COMMS_TOOLS: ToolDef[] = [list_reminders, create_reminder, complete_reminder, find_contact, suggest_merge, confirm_merge, calendar_list_events, calendar_find_time, calendar_create_event_google, calendar_create_event_outlook, mail_list_threads, mail_read_thread, mail_label_thread, mail_draft_reply, mail_send, social_send_dm];

/** Each tool's group (lib/agents/grants.ts TOOL_GROUPS). */
export const COMMS_TOOL_GROUP: Readonly<Record<string, ToolGroup>> = {
  list_reminders: "workspace",
  // Reminders are time-based personal planning: the scheduler sub-agent's group.
  create_reminder: "calendar",
  complete_reminder: "calendar",
  // Contacts: reads and proposals are workspace data; a merge writes CRM-side links (ops).
  find_contact: "workspace",
  suggest_merge: "workspace",
  confirm_merge: "ops",
  calendar_list_events: "calendar",
  calendar_find_time: "calendar",
  calendar_create_event_google: "calendar",
  calendar_create_event_outlook: "calendar",
  mail_list_threads: "email",
  mail_read_thread: "email",
  mail_label_thread: "email",
  mail_draft_reply: "email",
  mail_send: "email",
  // A DM through Zernio is the workspace's connected social account.
  social_send_dm: "social",
};

/** The automation action each non-safe tool stands for (its tier). */
export const COMMS_TOOL_ACTION: Readonly<Record<string, string>> = {
  create_reminder: "create_reminder",
  complete_reminder: "complete_reminder",
  confirm_merge: "confirm_contact_merge",
  // The connectors' own write actions (lib/agents/grants.ts connectorAction): same switch as the connector tools.
  calendar_create_event_google: "write_google_calendar",
  calendar_create_event_outlook: "write_outlook_calendar",
  mail_draft_reply: "draft_mail_reply",
  // The existing email send action (the Gmail / Outlook send tools' own): Tier 2.
  mail_send: "send_outreach_email",
  social_send_dm: "send_social_dm",
};
