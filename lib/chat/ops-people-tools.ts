// ShapesOS — Phase 12 (people): payroll and events tools for the agent.
//
// Part of OPS_TOOLS (lib/chat/ops-tools.ts spreads PEOPLE_OPS_TOOLS into
// it) — same ToolDef contract, same runOps tenant scoping, no new registry.
//
//   ops_payroll_overview          read (safe, ADMIN — salaries are private)
//   ops_payroll_draft_run         create + compute a pay run (Tier 0
//                                 draft_pay_run: nothing is approved, posted
//                                 or paid)
//   ops_payroll_request_approval  PROPOSE-ONLY: an OPS_PAYROLL_APPROVE
//                                 approval (Tier 3 approve_pay_run — never
//                                 automated; throws if anything executed)
//   ops_payroll_request_posting   PROPOSE-ONLY: OPS_PAYROLL_POST (Tier 3
//                                 post_pay_run)
//   ops_events_overview           read (safe, viewer)
//   ops_events_create_event       a DRAFT event + its first ticket type
//                                 (Tier 2 write_event; publishing stays a
//                                 person's switch on the Events page)
//   ops_events_register           staff registration: free tickets, or
//                                 complimentary seats (Tier 2 write_event)
// Nothing here moves money.

import type { Prisma } from "@prisma/client";
import { opsCreate, opsEntityDef, type OpsActor } from "@/lib/ops/doctype";
import type { OpsGatePort } from "@/lib/ops/gate";
import { fmtMoney } from "@/lib/ops/finance/money";
import { approvePayRun, computePayRun, payRunLabel, postPayRun } from "@/lib/ops/payroll/runs";
import { PAYROLL_TAX_DISCLAIMER } from "@/lib/ops/payroll/tax";
import { afterConfirmed } from "@/lib/ops/events/registrations";
import type { ToolContext, ToolDef, ToolResult } from "./tools";

type Tx = Prisma.TransactionClient;

const opsTools = () => import("./ops-tools");

async function port(p?: OpsGatePort): Promise<OpsGatePort> {
  return p ?? (await opsTools()).gatePort();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function int(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

function run(core: (tx: Tx, actor: OpsActor, args: Record<string, unknown>) => Promise<ToolResult>) {
  return async (ctx: ToolContext, args: Record<string, unknown>) => (await opsTools()).runOps(ctx, (tx, actor) => core(tx, actor, args));
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

export async function payrollOverviewCore(tx: Tx, actor: OpsActor): Promise<ToolResult> {
  const ws = actor.workspaceId;
  const [structures, assignments, runs] = await Promise.all([
    tx.opsSalaryStructure.count({ where: { workspaceId: ws, active: true } }),
    tx.opsSalaryAssignment.count({ where: { workspaceId: ws, OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }] } }),
    tx.opsPayRun.findMany({ where: { workspaceId: ws }, orderBy: { periodEnd: "desc" }, take: 10 }),
  ]);
  const waiting = runs.filter((r) => r.status === "computed" || r.status === "approved");
  return {
    summary:
      `${structures} active salary structure(s), ${assignments} current assignment(s); ` +
      `${runs.length} recent pay run(s)${waiting.length ? `, ${waiting.length} waiting for approval or posting` : ""}. ${PAYROLL_TAX_DISCLAIMER}`,
    details: {
      runs: runs.map((r) => ({
        id: r.id,
        label: payRunLabel(r),
        period: `${day(r.periodStart)}..${day(r.periodEnd)}`,
        payDate: day(r.payDate),
        status: r.status,
        payslips: r.payslipCount,
        grossCents: r.grossCents,
        netCents: r.netCents,
        employerTaxCents: r.employerTaxCents,
      })),
    },
  };
}

export async function payrollDraftRunCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>, p?: OpsGatePort): Promise<ToolResult> {
  const periodStart = str(args.periodStart);
  const periodEnd = str(args.periodEnd);
  const payDate = str(args.payDate);
  if (!periodStart || !periodEnd || !payDate) throw new Error('"periodStart", "periodEnd" and "payDate" (YYYY-MM-DD) are required');
  const r = await opsCreate(tx, opsEntityDef("pay-runs"), actor, { periodStart, periodEnd, payDate, ...(str(args.notes) ? { notes: str(args.notes) } : {}) }, { gatePort: await port(p) });
  if (r.outcome !== "done") throw new Error("expected a draft pay run, got an approval request");
  const computed = await computePayRun(tx, actor, String(r.row.id));
  const c = computed.run;
  return {
    summary:
      `Pay run ${payRunLabel(c)} computed for ${periodStart} to ${periodEnd}: ${computed.payslipCount} payslip(s), gross ${fmtMoney(c.grossCents)}, ` +
      `net pay ${fmtMoney(c.netCents)}, employer taxes ${fmtMoney(c.employerTaxCents)}${computed.warnings.length ? `; ${computed.warnings.length} warning(s) to review` : ""}. ` +
      `Nothing is approved or posted — a person reviews it on /dashboard/ops/payroll. ${PAYROLL_TAX_DISCLAIMER}`,
    details: { payRunId: c.id, number: c.number, status: c.status, warnings: computed.warnings.slice(0, 20) },
  };
}

/** Tier 3, propose-only: fails closed if anything was executed. */
export async function payrollRequestCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>, which: "approve" | "post", p?: OpsGatePort): Promise<ToolResult> {
  const id = str(args.payRunId);
  if (!id) throw new Error('"payRunId" is required');
  const r = which === "approve" ? await approvePayRun(tx, actor, id, undefined, await port(p)) : await postPayRun(tx, actor, id, undefined, await port(p));
  if (r.outcome === "done") {
    if (which === "post" && r.run.status === "posted") {
      return { summary: `Pay run ${payRunLabel(r.run)} is already posted (journal entry ${r.run.journalEntryId}).`, details: { payRunId: id, status: r.run.status } };
    }
    throw new Error("marketr: a payroll money decision executed without a person's approval — refusing to report success");
  }
  return {
    summary:
      `Approval required — ${which === "approve" ? "approving" : "posting"} the pay run was proposed as approval ${r.approval.id} (tier ${r.approval.riskTier}). ` +
      `A person approves it in the Actions queue (/dashboard/actions) and then ${which === "approve" ? "approves" : "posts"} the run on /dashboard/ops/payroll; the agent never does.`,
    details: { approvalRequired: true, approvalId: r.approval.id, riskTier: r.approval.riskTier, payRunId: id },
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function eventsOverviewCore(tx: Tx, actor: OpsActor): Promise<ToolResult> {
  const ws = actor.workspaceId;
  const events = await tx.opsEvent.findMany({
    where: { workspaceId: ws, status: { not: "cancelled" }, endsAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    orderBy: { startsAt: "asc" },
    take: 20,
    include: { ticketTypes: { select: { id: true, name: true, priceCents: true, quantity: true, soldCount: true, active: true } } },
  });
  const checkedIn = events.length
    ? await tx.opsEventAttendee.groupBy({ by: ["eventId"], where: { workspaceId: ws, eventId: { in: events.map((e) => e.id) }, checkedInAt: { not: null } }, _count: { _all: true } })
    : [];
  const ci = new Map(checkedIn.map((g) => [g.eventId, g._count._all]));
  return {
    summary: events.length
      ? events.map((e) => `"${e.title}" ${day(e.startsAt)} (${e.status}): ${e.reservedCount}${e.capacity != null ? `/${e.capacity}` : ""} seats taken, ${ci.get(e.id) ?? 0} checked in`).join("; ")
      : "No upcoming events.",
    details: {
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        slug: e.slug,
        url: `/events/${e.slug}`,
        status: e.status,
        startsAt: e.startsAt,
        capacity: e.capacity,
        reserved: e.reservedCount,
        checkedIn: ci.get(e.id) ?? 0,
        tickets: e.ticketTypes,
      })),
    },
  };
}

export async function eventsCreateCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>, p?: OpsGatePort): Promise<ToolResult> {
  const title = str(args.title);
  const startsAt = str(args.startsAt);
  const endsAt = str(args.endsAt);
  if (!title || !startsAt || !endsAt) throw new Error('"title", "startsAt" and "endsAt" (ISO date-times) are required');
  const body: Record<string, unknown> = { title, startsAt, endsAt };
  for (const k of ["venue", "webinarUrl", "description", "timezone"]) if (str(args[k])) body[k] = str(args[k]);
  const cap = int(args.capacity);
  if (cap !== undefined) body.capacity = cap;
  const gp = await port(p);
  const ev = await opsCreate(tx, opsEntityDef("events"), actor, body, { gatePort: gp });
  if (ev.outcome !== "done") throw new Error("expected a draft event");
  const price = int(args.priceCents) ?? 0;
  const qty = int(args.ticketQuantity);
  const tt = await opsCreate(
    tx,
    opsEntityDef("event-ticket-types"),
    actor,
    { eventId: ev.row.id, name: str(args.ticketName) ?? (price > 0 ? "General admission" : "Free registration"), priceCents: price, ...(qty !== undefined ? { quantity: qty } : {}) },
    { gatePort: gp },
  );
  if (tt.outcome !== "done") throw new Error("expected a ticket type");
  return {
    summary: `Draft event "${title}" created at /events/${String(ev.row.slug)} with a ${price > 0 ? fmtMoney(price) : "free"} ticket. A person publishes it on /dashboard/ops/events${price > 0 ? " (paid tickets need Stripe connected in Finance settings)" : ""}.`,
    details: { eventId: ev.row.id, slug: ev.row.slug, ticketTypeId: tt.row.id, status: "draft" },
  };
}

export async function eventsRegisterCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>, p?: OpsGatePort): Promise<ToolResult> {
  const ticketTypeId = str(args.ticketTypeId);
  const name = str(args.name);
  const email = str(args.email);
  if (!ticketTypeId || !name || !email) throw new Error('"ticketTypeId", "name" and "email" are required');
  const r = await opsCreate(
    tx,
    opsEntityDef("event-registrations"),
    actor,
    { ticketTypeId, name, email, quantity: int(args.quantity) ?? 1, comp: str(args.comp) === "true" },
    { gatePort: await port(p) },
  );
  if (r.outcome !== "done") throw new Error("expected a registration");
  return {
    summary: `Registered ${name} <${email}> × ${String(r.row.quantity)} — ${String(r.row.status)}${r.row.unitPriceCents === 0 && args.comp === "true" ? " (complimentary)" : ""}. Their QR tickets are on the event page's registrations list.`,
    details: { registrationId: r.row.id, status: r.row.status, contactId: r.row.contactId },
  };
}

export const PEOPLE_OPS_TOOLS: ToolDef[] = [
  {
    name: "ops_payroll_overview",
    description: "Payroll at a glance: active salary structures, current assignments and the latest pay runs (period, status, gross, net, employer taxes). Admins only.",
    kind: "safe",
    minRole: "admin",
    argsSchema: { type: "object", properties: {} },
    execute: run((tx, a) => payrollOverviewCore(tx, a)),
  },
  {
    name: "ops_payroll_draft_run",
    description:
      "Create a pay run for a period and compute everyone's payslip (salary, approved timesheet hours with overtime, allowances, deductions, US federal + state withholding estimates). Nothing is approved, posted or paid.",
    kind: "publish",
    minRole: "admin",
    argsSchema: {
      type: "object",
      properties: {
        periodStart: { type: "string", description: "First day of the pay period, YYYY-MM-DD (required)." },
        periodEnd: { type: "string", description: "Last day of the pay period, YYYY-MM-DD (required)." },
        payDate: { type: "string", description: "Pay date, YYYY-MM-DD (required; taxes follow the pay date's year)." },
        notes: { type: "string", description: "Notes (optional)." },
      },
      required: ["periodStart", "periodEnd", "payDate"],
    },
    execute: run((tx, a, args) => payrollDraftRunCore(tx, a, args)),
  },
  {
    name: "ops_payroll_request_approval",
    description:
      "PROPOSE approving a computed pay run (Tier 3 money decision). Only creates a Phase 14 approval for a person; the agent never approves payroll.",
    kind: "publish",
    minRole: "admin",
    argsSchema: { type: "object", properties: { payRunId: { type: "string", description: "Pay run id (required)." } }, required: ["payRunId"] },
    execute: run((tx, a, args) => payrollRequestCore(tx, a, args, "approve")),
  },
  {
    name: "ops_payroll_request_posting",
    description:
      "PROPOSE posting an approved pay run to the books (Tier 3). Only creates a Phase 14 approval; a person posts it. Posting writes one balanced journal entry; it never pays anyone.",
    kind: "publish",
    minRole: "admin",
    argsSchema: { type: "object", properties: { payRunId: { type: "string", description: "Pay run id (required)." } }, required: ["payRunId"] },
    execute: run((tx, a, args) => payrollRequestCore(tx, a, args, "post")),
  },
  {
    name: "ops_events_overview",
    description: "Upcoming events: dates, status, public page, seats taken vs capacity, ticket types and check-ins.",
    kind: "safe",
    minRole: "viewer",
    argsSchema: { type: "object", properties: {} },
    execute: run((tx, a) => eventsOverviewCore(tx, a)),
  },
  {
    name: "ops_events_create_event",
    description:
      "Create a DRAFT event (venue or webinar link, start/end, optional capacity) with its first ticket type (free unless priceCents is set). Does not publish it.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title (required)." },
        startsAt: { type: "string", description: "Start, ISO date-time (required)." },
        endsAt: { type: "string", description: "End, ISO date-time (required)." },
        venue: { type: "string", description: "Venue / address (optional)." },
        webinarUrl: { type: "string", description: "https:// webinar link, shown only on confirmed tickets (optional)." },
        description: { type: "string", description: "Description (optional)." },
        timezone: { type: "string", description: "IANA time zone, e.g. America/New_York (optional)." },
        capacity: { type: "string", description: "Total seats (optional; blank = unlimited)." },
        ticketName: { type: "string", description: "First ticket type's name (optional)." },
        priceCents: { type: "string", description: "Ticket price in cents (optional; 0 = free)." },
        ticketQuantity: { type: "string", description: "How many of this ticket (optional)." },
      },
      required: ["title", "startsAt", "endsAt"],
    },
    execute: run((tx, a, args) => eventsCreateCore(tx, a, args)),
  },
  {
    name: "ops_events_register",
    description:
      "Register someone for an event on a free ticket type, or give complimentary seats on a paid one (comp=\"true\"). Paid tickets are otherwise bought on the public page. Matches or creates their contact.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        ticketTypeId: { type: "string", description: "Ticket type id (required)." },
        name: { type: "string", description: "Registrant name (required)." },
        email: { type: "string", description: "Registrant email (required)." },
        quantity: { type: "string", description: "Seats (optional, default 1)." },
        comp: { type: "string", description: '"true" for complimentary seats on a paid ticket (optional).' },
      },
      required: ["ticketTypeId", "name", "email"],
    },
    async execute(ctx, args) {
      const out = await (await opsTools()).runOps(ctx, (tx, a) => eventsRegisterCore(tx, a, args));
      const d = out.details as { registrationId?: string; status?: string };
      if (d.status === "confirmed" && d.registrationId) await afterConfirmed(ctx.workspaceId, d.registrationId);
      return out;
    },
  },
];
