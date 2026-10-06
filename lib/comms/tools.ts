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

export const COMMS_TOOLS: ToolDef[] = [list_reminders, create_reminder, complete_reminder];

/** Each tool's group (lib/agents/grants.ts TOOL_GROUPS). */
export const COMMS_TOOL_GROUP: Readonly<Record<string, ToolGroup>> = {
  list_reminders: "workspace",
  // Reminders are time-based personal planning: the scheduler sub-agent's group.
  create_reminder: "calendar",
  complete_reminder: "calendar",
};

/** The automation action each non-safe tool stands for (its tier). */
export const COMMS_TOOL_ACTION: Readonly<Record<string, string>> = {
  create_reminder: "create_reminder",
  complete_reminder: "complete_reminder",
};
