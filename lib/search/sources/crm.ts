// ShapesOS — Spotlight sources: CRM (leads, contacts, companies, deals) and
// the lead conversation inbox. All read at viewer (the CRM and Inbox pages'
// gate). ops_contacts / ops_companies / ops_deals are FORCE RLS (the scope
// transaction filters them); every statement also filters workspace_id.

import { Prisma } from "@prisma/client";
import { tableSearch } from "../sql";
import type { SearchSource } from "../types";
import { money } from "./util";

export const lead: SearchSource = {
  kind: "lead",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "crm_leads t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.name AS title, concat_ws(' · ', nullif(t.company, ''), nullif(t.email, '')) AS sub, t.stage AS extra, NULL::int AS n, t.updated_at AS updated_at",
      // Same expression as the Phase 4a trigram index (crm_leads_search_trgm_idx).
      nameMatch: "(t.name || ' ' || coalesce(t.email, '') || ' ' || coalesce(t.company, '') || ' ' || coalesce(t.phone, ''))",
      nameSim: "t.name",
      fts: { table: "crm_leads", alias: "t" },
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Lead",
    subtitle: [r.sub, r.extra ? `stage ${r.extra}` : null].filter(Boolean).join(" · ") || null,
    href: `/dashboard/crm?lead=${encodeURIComponent(r.id)}`,
    ref: { leadId: r.id },
  }),
  actions: [
    { id: "follow_up", tool: "create_content_draft", instruction: "Draft a short follow-up message to this lead (a draft only; sending still asks)." },
    { id: "convert_lead", tool: "ops_convert_lead", instruction: "Convert this lead into a contact and an open deal (this asks before it writes)." },
  ],
};

export const contact: SearchSource = {
  kind: "contact",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "ops_contacts t LEFT JOIN ops_companies c ON c.id = t.company_id AND c.workspace_id = t.workspace_id",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.name AS title, concat_ws(' · ', nullif(t.title, ''), c.name, nullif(t.email, '')) AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "(t.name || ' ' || coalesce(t.email, '') || ' ' || coalesce(t.phone, ''))",
      nameSim: "t.name",
      fts: { table: "ops_contacts", alias: "t" },
      snippetSource: "t.notes",
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Contact",
    subtitle: r.sub || null,
    href: `/dashboard/crm?tab=contacts&contact=${encodeURIComponent(r.id)}`,
  }),
  actions: [{ id: "create_deal", tool: "ops_create_deal", instruction: "Open a deal for this contact (this asks before it writes)." }],
};

export const company: SearchSource = {
  kind: "company",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "ops_companies t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.name AS title, concat_ws(' · ', nullif(t.domain, ''), nullif(t.industry, '')) AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "(t.name || ' ' || coalesce(t.domain, ''))",
      nameSim: "t.name",
      fts: { table: "ops_companies", alias: "t" },
      snippetSource: "t.notes",
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Company",
    subtitle: r.sub || null,
    href: `/dashboard/crm?tab=companies&company=${encodeURIComponent(r.id)}`,
  }),
};

export const deal: SearchSource = {
  kind: "deal",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "ops_deals t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.title AS title, t.status::text AS sub, t.stage AS extra, t.value_cents AS n, t.updated_at AS updated_at",
      nameMatch: "t.title",
      fts: { table: "ops_deals", alias: "t" },
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Deal",
    subtitle: [money(r.n), r.sub, r.extra ? `stage ${r.extra}` : null].filter(Boolean).join(" · ") || null,
    href: `/dashboard/crm?tab=deals&deal=${encodeURIComponent(r.id)}`,
  }),
  actions: [{ id: "move_deal", tool: "ops_move_deal_stage", instruction: "Move this deal to the stage it should be in next, with a one-line reason (this asks before it writes)." }],
};

/**
 * The lead conversation inbox: every SMS / email in the messaging ledger
 * (outbound sends and inbound replies) matched to a lead. One hit per
 * message; it opens the lead's thread.
 */
export const inboxMessage: SearchSource = {
  kind: "inbox_message",
  minRole: "viewer",
  modes: ["text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "outbound_message t JOIN crm_leads l ON l.id = t.lead_id AND l.workspace_id = t.workspace_id",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select:
        "t.id, coalesce(nullif(t.subject, ''), left(regexp_replace(t.body, '[[:space:]]+', ' ', 'g'), 90)) AS title, l.name AS sub, t.channel || ' ' || t.direction AS extra, NULL::int AS n, t.created_at AS updated_at, t.lead_id AS lead_id",
      nameMatch: null,
      fts: { table: "outbound_message", alias: "t" },
      snippetSource: "t.body",
      passthrough: ["lead_id"],
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title || "Message",
    subtitle: [r.sub, r.extra].filter(Boolean).join(" · ") || null,
    // The row id is the message; the thread is the lead (the extra column
    // carries channel + direction, lead_id rides along as an extra column).
    href: `/dashboard/crm/inbox?lead=${encodeURIComponent((r as unknown as { lead_id?: string }).lead_id ?? "")}`,
    ref: { leadId: (r as unknown as { lead_id?: string }).lead_id },
  }),
};
