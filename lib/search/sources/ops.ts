// ShapesOS — Spotlight sources: Operations (invoices, client projects,
// helpdesk tickets). Viewer reads (the Operations pages' gate, lib/ops/
// page-guard requireOpsViewer). All three tables are FORCE RLS.

import { Prisma } from "@prisma/client";
import { ftsVector } from "../fts";
import { tableSearch } from "../sql";
import type { SearchSource } from "../types";
import { money } from "./util";

export const invoice: SearchSource = {
  kind: "invoice",
  minRole: "viewer",
  modes: ["name"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "ops_invoices t LEFT JOIN crm_leads l ON l.id = t.customer_id AND l.workspace_id = t.workspace_id",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, l.name AS title, t.status::text AS sub, NULL::text AS extra, t.total_cents AS n, t.updated_at AS updated_at",
      // The customer's name, or the invoice id typed from its start.
      nameMatch: "(coalesce(l.name, '') || ' ' || t.id)",
      nameSim: "coalesce(l.name, '')",
    }),
  hit: (r) => ({
    id: r.id,
    title: `Invoice ${r.id.length > 12 ? `${r.id.slice(0, 8)}…` : r.id}${r.title ? ` · ${r.title}` : ""}`,
    subtitle: [money(r.n), r.sub].filter(Boolean).join(" · ") || null,
    href: `/dashboard/ops/invoices?invoice=${encodeURIComponent(r.id)}`,
  }),
  // Sending an invoice is Tier 3 (money): the agent can only propose it.
  actions: [{ id: "send_invoice", tool: "ops_send_invoice", instruction: "Check this invoice and propose sending it to the customer (money: it always waits for a person)." }],
};

export const opsProject: SearchSource = {
  kind: "ops_project",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "ops_projects t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.name AS title, t.status::text AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.name",
      fts: { table: "ops_projects", alias: "t" },
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Project",
    subtitle: r.sub ? `Client project · ${r.sub}` : "Client project",
    href: "/dashboard/ops/projects",
  }),
  actions: [{ id: "create_task", tool: "ops_create_task", instruction: "Add the next task this project needs (this asks before it writes)." }],
};

/**
 * Helpdesk tickets: the subject and requester, and every message in the
 * thread (inbound email, replies, notes). One hit per ticket; the snippet
 * is the best-matching message.
 */
export const ticket: SearchSource = {
  kind: "ticket",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) => {
    const msgVec = ftsVector("ops_ticket_messages", "mm");
    const inThread = `FROM ops_ticket_messages mm WHERE mm.ticket_id = t.id AND mm.workspace_id = t.workspace_id AND ${msgVec} @@ qq.tq`;
    return tableSearch(tx, ctx, {
      from: "ops_tickets t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, '#' || t.number || ' ' || t.subject AS title, t.status::text AS sub, t.priority::text AS extra, t.number AS n, t.updated_at AS updated_at",
      nameMatch: "('#' || t.number || ' ' || t.subject || ' ' || coalesce(t.requester_email, ''))",
      nameSim: "t.subject",
      fts: { table: "ops_tickets", alias: "t" },
      extra: {
        match: `EXISTS (SELECT 1 ${inThread})`,
        rank: `SELECT max(ts_rank_cd(${msgVec}, qq.tq)) ${inThread}`,
      },
      snippetSource: `(SELECT mm.body ${inThread} ORDER BY ts_rank_cd(${msgVec}, qq.tq) DESC, mm.created_at DESC LIMIT 1)`,
    });
  },
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Ticket",
    subtitle: [r.sub, r.extra ? `${r.extra} priority` : null].filter(Boolean).join(" · ") || null,
    href: `/dashboard/ops/helpdesk?ticket=${encodeURIComponent(r.id)}`,
  }),
  actions: [
    { id: "reply_ticket", tool: "ops_reply_ticket", instruction: "Draft a reply to this ticket's latest message (sending asks first)." },
    { id: "close_ticket", tool: "ops_close_ticket", instruction: "If this ticket is resolved, close it with a one-line resolution (this asks before it writes)." },
  ],
};
