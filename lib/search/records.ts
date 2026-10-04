// ShapesOS — global record search (Phase 4a, audit §7 item 11).
//
// One query, many record types, always inside the caller's workspace:
// leads, invoices, Office docs, files, SEO projects, ops projects, missions,
// CAD projects, e-sign envelopes, legal documents, agency clients and social
// posts.
// Every source runs in ONE withWorkspaceScope transaction, so FORCE-RLS
// tables (ops_invoices, ops_projects, univer_docs, missions) are filtered by
// Postgres itself, and every statement also carries an explicit
// workspace_id predicate for the non-RLS tables.
//
// Matching is ILIKE '%q%' over the expressions indexed with pg_trgm GIN in
// migration 20261005300100_phase4a_record_search (keep them identical),
// ranked by trigram similarity, then recency. Each source has a minimum
// workspace role matching the read gate of the page it links to.

import type { WorkspaceRole } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { roleAtLeast } from "@/lib/authz";

export { RECORD_KINDS, RECORD_KIND_LABELS, type RecordKind } from "./kinds";
import { RECORD_KINDS, type RecordKind } from "./kinds";

/**
 * Minimum role per source — the same gate as the page each result opens
 * (CRM, Office, Files, Missions, CAD, E-sign and Legal read at viewer;
 * agency clients are visible to any member). Raise one here and the search
 * hides those results from lower roles.
 */
export const RECORD_MIN_ROLE: Record<RecordKind, WorkspaceRole> = {
  lead: "viewer",
  invoice: "viewer",
  doc: "viewer",
  file: "viewer",
  project: "viewer",
  ops_project: "viewer",
  mission: "viewer",
  cad_project: "viewer",
  envelope: "viewer",
  legal_document: "viewer",
  client: "viewer",
  // Phase 4b: CAD BOM lines (CAD reads at viewer) and datasets (Datasets
  // page reads at viewer).
  bom_line: "viewer",
  dataset: "viewer",
  social_post: "viewer",
};

export interface RecordHit {
  kind: RecordKind;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;

/** Trim, collapse whitespace, cap length. Returns null when too short. */
export function normalizeQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  return q.length >= MIN_QUERY_LENGTH ? q : null;
}

/** ILIKE pattern with %, _ and \ escaped (default ESCAPE is backslash). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function money(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return "";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const DOC_KIND: Record<string, string> = { sheet: "Sheet", doc: "Doc", slide: "Deck" };

type Row = { id: string; title: string | null; sub: string | null; extra: string | null; n: number | null };
type Tx = Prisma.TransactionClient;
type SourceQuery = (tx: Tx, ws: string, q: string, p: string, limit: number) => Promise<Row[]>;

const SOURCES: Record<RecordKind, { query: SourceQuery; hit: (r: Row) => Omit<RecordHit, "kind"> }> = {
  lead: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, name AS title, concat_ws(' · ', nullif(company, ''), nullif(email, '')) AS sub, stage AS extra, NULL::int AS n
        FROM crm_leads
       WHERE workspace_id = ${ws}
         AND (name || ' ' || coalesce(email, '') || ' ' || coalesce(company, '') || ' ' || coalesce(phone, '')) ILIKE ${p}
       ORDER BY similarity(name, ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: r.title ?? "Lead",
      subtitle: [r.sub, r.extra ? `stage ${r.extra}` : null].filter(Boolean).join(" · ") || null,
      href: `/dashboard/crm?lead=${encodeURIComponent(r.id)}`,
    }),
  },
  invoice: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT i.id, l.name AS title, i.status::text AS sub, NULL::text AS extra, i.total_cents AS n
        FROM ops_invoices i
        LEFT JOIN crm_leads l ON l.id = i.customer_id AND l.workspace_id = i.workspace_id
       WHERE i.workspace_id = ${ws}
         AND (l.name ILIKE ${p} OR i.id ILIKE ${`${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`})
       ORDER BY similarity(coalesce(l.name, ''), ${q}) DESC, i.updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: `Invoice ${r.id.length > 12 ? `${r.id.slice(0, 8)}…` : r.id}${r.title ? ` · ${r.title}` : ""}`,
      subtitle: [money(r.n), r.sub].filter(Boolean).join(" · ") || null,
      href: `/dashboard/crm?tab=invoicing&invoice=${encodeURIComponent(r.id)}`,
    }),
  },
  doc: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, title, kind AS sub, NULL::text AS extra, NULL::int AS n
        FROM univer_docs
       WHERE workspace_id = ${ws} AND title ILIKE ${p}
       ORDER BY similarity(title, ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: r.title ?? "Untitled",
      subtitle: r.sub ? `Office · ${DOC_KIND[r.sub] ?? r.sub}` : "Office",
      href: `/dashboard/office?open=${encodeURIComponent(r.id)}`,
    }),
  },
  file: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, filename AS title, logical_path AS sub, NULL::text AS extra, NULL::int AS n
        FROM workspace_files
       WHERE workspace_id = ${ws} AND trashed_at IS NULL
         AND (filename || ' ' || logical_path) ILIKE ${p}
       ORDER BY similarity(filename, ${q}) DESC, created_at DESC
       LIMIT ${n}`,
    hit: (r) => ({ id: r.id, title: r.title ?? "File", subtitle: r.sub, href: "/dashboard/files" }),
  },
  project: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, domain AS title, locale AS sub, NULL::text AS extra, NULL::int AS n
        FROM projects
       WHERE workspace_id = ${ws} AND domain ILIKE ${p}
       ORDER BY similarity(domain, ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: r.title ?? "Project",
      subtitle: r.sub ? `SEO project · ${r.sub}` : "SEO project",
      href: `/dashboard/projects/${encodeURIComponent(r.id)}`,
    }),
  },
  ops_project: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, name AS title, status::text AS sub, NULL::text AS extra, NULL::int AS n
        FROM ops_projects
       WHERE workspace_id = ${ws} AND name ILIKE ${p}
       ORDER BY similarity(name, ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: r.title ?? "Project",
      subtitle: r.sub ? `Client project · ${r.sub}` : "Client project",
      href: "/dashboard/crm?tab=projects",
    }),
  },
  mission: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, coalesce(goal ->> 'label', template) AS title, status::text AS sub, NULL::text AS extra, NULL::int AS n
        FROM missions
       WHERE workspace_id = ${ws} AND coalesce(goal ->> 'label', template) ILIKE ${p}
       ORDER BY similarity(coalesce(goal ->> 'label', template), ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: r.title ?? "Mission",
      subtitle: r.sub ? `Mission · ${r.sub}` : "Mission",
      href: `/dashboard/missions/${encodeURIComponent(r.id)}`,
    }),
  },
  cad_project: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, name AS title, description AS sub, NULL::text AS extra, NULL::int AS n
        FROM cad_projects
       WHERE workspace_id = ${ws} AND name ILIKE ${p}
       ORDER BY similarity(name, ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: r.title ?? "CAD project",
      subtitle: r.sub?.slice(0, 120) ?? "CAD project",
      href: `/dashboard/cad?project=${encodeURIComponent(r.id)}`,
    }),
  },
  envelope: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, title, status AS sub, NULL::text AS extra, NULL::int AS n
        FROM esign_envelopes
       WHERE workspace_id = ${ws} AND title ILIKE ${p}
       ORDER BY similarity(title, ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({ id: r.id, title: r.title ?? "Envelope", subtitle: r.sub ? `E-sign · ${r.sub}` : "E-sign", href: "/dashboard/esign" }),
  },
  legal_document: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, title, doc_type::text AS sub, NULL::text AS extra, NULL::int AS n
        FROM legal_documents
       WHERE workspace_id = ${ws} AND title ILIKE ${p}
       ORDER BY similarity(title, ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: r.title ?? "Document",
      subtitle: r.sub ? `Legal · ${r.sub.replace(/_/g, " ")}` : "Legal",
      href: "/dashboard/legal",
    }),
  },
  client: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, name AS title, NULL::text AS sub, NULL::text AS extra, NULL::int AS n
        FROM clients
       WHERE workspace_id = ${ws} AND name ILIKE ${p}
       ORDER BY similarity(name, ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({ id: r.id, title: r.title ?? "Client", subtitle: "Agency client", href: "/dashboard/settings/clients" }),
  },
  // Phase 4b. One hit per BOM line; `extra` carries "<projectId>|<modelId>"
  // for the deep link, `sub` the model + BOM + revision label.
  bom_line: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT l.id,
             l.part_name AS title,
             concat_ws(' · ', m.name, 'BOM #' || b.bom_number, 'v' || v.version_number, nullif(l.material_spec, '')) AS sub,
             m.project_id || '|' || m.id AS extra,
             NULL::int AS n
        FROM cad_bom_lines l
        JOIN cad_bom_versions b ON b.id = l.bom_version_id AND b.workspace_id = l.workspace_id
        JOIN cad_models m ON m.id = b.model_id AND m.workspace_id = l.workspace_id
        JOIN cad_model_versions v ON v.id = b.model_version_id AND v.workspace_id = l.workspace_id
       WHERE l.workspace_id = ${ws}
         AND (l.part_name || ' ' || coalesce(l.material_spec, '')) ILIKE ${p}
       ORDER BY similarity(l.part_name, ${q}) DESC, l.updated_at DESC
       LIMIT ${n}`,
    hit: (r) => {
      const [projectId = "", modelId = ""] = (r.extra ?? "").split("|");
      return {
        id: r.id,
        title: r.title ?? "BOM part",
        subtitle: r.sub ? `BOM part · ${r.sub}` : "BOM part",
        href: `/dashboard/cad?project=${encodeURIComponent(projectId)}&model=${encodeURIComponent(modelId)}&tab=prototype`,
      };
    },
  },
  dataset: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT d.id, d.name AS title,
             (SELECT 'v' || max(v.version) FROM dataset_versions v WHERE v.dataset_id = d.id) AS sub,
             NULL::text AS extra, NULL::int AS n
        FROM datasets d
       WHERE d.workspace_id = ${ws} AND d.name ILIKE ${p}
       ORDER BY similarity(d.name, ${q}) DESC, d.updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: `${r.title ?? "Dataset"} dataset`,
      subtitle: r.sub ? `Dataset · latest ${r.sub}` : "Dataset · not compiled yet",
      href: "/dashboard/datasets?tab=build",
    }),
  },
  // Phase 4b: social posts (FORCE RLS; the scope transaction filters them).
  social_post: {
    query: (tx, ws, q, p, n) => tx.$queryRaw<Row[]>`
      SELECT id, left(regexp_replace(content, '[[:space:]]+', ' ', 'g'), 120) AS title, status::text AS sub, NULL::text AS extra, NULL::int AS n
        FROM social_publications
       WHERE workspace_id = ${ws} AND content ILIKE ${p}
       ORDER BY similarity(content, ${q}) DESC, updated_at DESC
       LIMIT ${n}`,
    hit: (r) => ({
      id: r.id,
      title: r.title || "Social post",
      subtitle: r.sub ? `Social · ${r.sub.replace(/_/g, " ")}` : "Social",
      href: `/dashboard/social?post=${encodeURIComponent(r.id)}`,
    }),
  },
};

export interface SearchOptions {
  /** Results per record type (default 5, max 20). */
  perKind?: number;
  /** Restrict to these record types. */
  kinds?: readonly RecordKind[];
}

/**
 * Search the workspace's records for `rawQuery` as a member with `role`.
 * Returns [] for queries shorter than MIN_QUERY_LENGTH. Results are grouped
 * in RECORD_KINDS order (leads first), best match first within a group.
 */
export async function searchRecords(
  workspaceId: string,
  role: WorkspaceRole | null | undefined,
  rawQuery: unknown,
  opts: SearchOptions = {},
): Promise<RecordHit[]> {
  const q = normalizeQuery(rawQuery);
  if (!q || !workspaceId || !role) return [];
  const perKind = Math.min(Math.max(Math.floor(opts.perKind ?? 5), 1), 20);
  const kinds = RECORD_KINDS.filter(
    (k) => (!opts.kinds || opts.kinds.includes(k)) && roleAtLeast(role, RECORD_MIN_ROLE[k]),
  );
  if (kinds.length === 0) return [];
  const pattern = likePattern(q);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const hits: RecordHit[] = [];
    for (const kind of kinds) {
      const source = SOURCES[kind];
      const rows = await source.query(tx as Tx, workspaceId, q, pattern, perKind);
      for (const r of rows) hits.push({ kind, ...source.hit(r) });
    }
    return hits;
  });
}
