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

export const COMMS_TOOLS: ToolDef[] = [list_reminders, create_reminder, complete_reminder, find_contact, suggest_merge, confirm_merge];

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
};

/** The automation action each non-safe tool stands for (its tier). */
export const COMMS_TOOL_ACTION: Readonly<Record<string, string>> = {
  create_reminder: "create_reminder",
  complete_reminder: "complete_reminder",
  confirm_merge: "confirm_contact_merge",
};
