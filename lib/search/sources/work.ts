// ShapesOS — Spotlight sources: the work apps (Office docs, files by name,
// SEO projects, missions, CAD, e-sign, legal, agency clients, BOM parts,
// datasets, social posts, mini-apps). Each keeps the read gate of the page it
// opens (viewer), except unpublished mini-apps: a draft app is editor-only
// (lib/apps/service.ts loadApp), so viewers never find it.

import { Prisma } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import { tableSearch } from "../sql";
import type { SearchSource } from "../types";

const DOC_KIND: Record<string, string> = { sheet: "Sheet", doc: "Doc", slide: "Deck" };

export const doc: SearchSource = {
  kind: "doc",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "univer_docs t",
      // Phase 18.2 (WS=content): notes (kind "note") are their own source (./notes.ts).
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.kind <> 'note'`,
      select: "t.id, t.title AS title, t.kind AS sub, t.share_state AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.title",
      fts: { table: "univer_docs", alias: "t" },
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Untitled",
    subtitle: r.sub ? `Office · ${DOC_KIND[r.sub] ?? r.sub}` : "Office",
    href: `/dashboard/office?open=${encodeURIComponent(r.id)}`,
    ref: { docId: r.id },
  }),
  actions: [{ id: "summarize", tool: "create_content_draft", instruction: "Summarize this document in five bullet points." }],
};

export const file: SearchSource = {
  kind: "file",
  minRole: "viewer",
  modes: ["name"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "workspace_files t",
      // Phase 21B (WS=drive): a file in someone's private home is theirs alone to find.
      scope: ctx.userId
        ? Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.trashed_at IS NULL AND (t.owner_user_id IS NULL OR t.owner_user_id = ${ctx.userId})`
        : Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.trashed_at IS NULL AND t.owner_user_id IS NULL`,
      select: "t.id, t.filename AS title, t.logical_path AS sub, t.mime_type AS extra, t.size_bytes AS n, t.created_at AS updated_at",
      // Same expression as workspace_files_search_trgm_idx.
      nameMatch: "(t.filename || ' ' || t.logical_path)",
      nameSim: "t.filename",
    }),
  // Phase 18.2 (WS=content): Files opens the file's preview (?file=).
  hit: (r) => ({ id: r.id, title: r.title ?? "File", subtitle: r.sub, href: `/dashboard/files?file=${encodeURIComponent(r.id)}`, ref: { fileId: r.id } }),
  actions: [{ id: "summarize", tool: "create_content_draft", instruction: "Read this file and summarize it in five bullet points." }],
};

export const project: SearchSource = {
  kind: "project",
  minRole: "viewer",
  modes: ["name"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "projects t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.domain AS title, t.locale AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.domain",
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Project",
    subtitle: r.sub ? `SEO project · ${r.sub}` : "SEO project",
    href: `/dashboard/projects/${encodeURIComponent(r.id)}`,
  }),
  actions: [{ id: "seo_audit", tool: "run_seo_audit", instruction: "Run an SEO audit on this site and tell me the three biggest problems." }],
};

export const mission: SearchSource = {
  kind: "mission",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "missions t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, coalesce(t.goal ->> 'label', t.template) AS title, t.status::text AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "coalesce(t.goal ->> 'label', t.template)",
      fts: { table: "missions", alias: "t" },
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Mission",
    subtitle: r.sub ? `Mission · ${r.sub}` : "Mission",
    href: `/dashboard/missions/${encodeURIComponent(r.id)}`,
  }),
};

export const cadProject: SearchSource = {
  kind: "cad_project",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "cad_projects t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.name AS title, t.description AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.name",
      fts: { table: "cad_projects", alias: "t" },
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "CAD project",
    subtitle: r.sub?.slice(0, 120) ?? "CAD project",
    href: `/dashboard/cad?project=${encodeURIComponent(r.id)}`,
  }),
};

export const envelope: SearchSource = {
  kind: "envelope",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "esign_envelopes t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.title AS title, t.status AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.title",
      fts: { table: "esign_envelopes", alias: "t" },
    }),
  hit: (r) => ({ id: r.id, title: r.title ?? "Envelope", subtitle: r.sub ? `E-sign · ${r.sub}` : "E-sign", href: "/dashboard/esign" }),
};

export const legalDocument: SearchSource = {
  kind: "legal_document",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "legal_documents t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.title AS title, t.doc_type::text AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.title",
      fts: { table: "legal_documents", alias: "t" },
      snippetSource: "t.notes",
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Document",
    subtitle: r.sub ? `Legal · ${r.sub.replace(/_/g, " ")}` : "Legal",
    href: "/dashboard/legal",
  }),
};

export const client: SearchSource = {
  kind: "client",
  minRole: "viewer",
  modes: ["name"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "clients t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.name AS title, NULL::text AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.name",
    }),
  hit: (r) => ({ id: r.id, title: r.title ?? "Client", subtitle: "Agency client", href: "/dashboard/settings/clients" }),
};

/** Phase 4b. One hit per BOM line; `extra` carries "<projectId>|<modelId>" for the deep link. */
export const bomLine: SearchSource = {
  kind: "bom_line",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: `cad_bom_lines t
        JOIN cad_bom_versions b ON b.id = t.bom_version_id AND b.workspace_id = t.workspace_id
        JOIN cad_models m2 ON m2.id = b.model_id AND m2.workspace_id = t.workspace_id
        JOIN cad_model_versions v ON v.id = b.model_version_id AND v.workspace_id = t.workspace_id`,
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select:
        "t.id, t.part_name AS title, concat_ws(' · ', m2.name, 'BOM #' || b.bom_number, 'v' || v.version_number, nullif(t.material_spec, '')) AS sub, m2.project_id || '|' || m2.id AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "(t.part_name || ' ' || coalesce(t.material_spec, ''))",
      nameSim: "t.part_name",
      fts: { table: "cad_bom_lines", alias: "t" },
    }),
  hit: (r) => {
    const [projectId = "", modelId = ""] = (r.extra ?? "").split("|");
    return {
      id: r.id,
      title: r.title ?? "BOM part",
      subtitle: r.sub ? `BOM part · ${r.sub}` : "BOM part",
      href: `/dashboard/cad?project=${encodeURIComponent(projectId)}&model=${encodeURIComponent(modelId)}&tab=prototype`,
    };
  },
};

export const dataset: SearchSource = {
  kind: "dataset",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "datasets t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select:
        "t.id, t.name AS title, (SELECT 'v' || max(dv.version) FROM dataset_versions dv WHERE dv.dataset_id = t.id) AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.name",
      fts: { table: "datasets", alias: "t" },
    }),
  hit: (r) => ({
    id: r.id,
    title: `${r.title ?? "Dataset"} dataset`,
    subtitle: r.sub ? `Dataset · latest ${r.sub}` : "Dataset · not compiled yet",
    href: "/dashboard/datasets?tab=build",
  }),
};

/** Phase 4b: social posts (FORCE RLS; the scope transaction filters them). */
export const socialPost: SearchSource = {
  kind: "social_post",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "social_publications t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, left(regexp_replace(t.content, '[[:space:]]+', ' ', 'g'), 120) AS title, t.status::text AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.content",
      nameSim: "left(t.content, 200)",
      fts: { table: "social_publications", alias: "t" },
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title || "Social post",
    subtitle: r.sub ? `Social · ${r.sub.replace(/_/g, " ")}` : "Social",
    href: `/dashboard/social?post=${encodeURIComponent(r.id)}`,
  }),
};

/** Mini-apps (Phase 9). Unpublished = draft: editors and up only. */
export const app: SearchSource = {
  kind: "app",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "mini_apps t",
      scope: roleAtLeast(ctx.role, "editor")
        ? Prisma.sql`t.workspace_id = ${ctx.workspaceId}`
        : Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.published = true`,
      select: "t.id, t.name AS title, t.description AS sub, CASE WHEN t.published THEN 'published' ELSE 'draft' END AS extra, NULL::int AS n, t.updated_at AS updated_at, t.slug AS slug",
      nameMatch: "t.name",
      fts: { table: "mini_apps", alias: "t" },
      passthrough: ["slug"],
    }),
  hit: (r) => {
    const slug = (r as unknown as { slug?: string }).slug ?? "";
    return {
      id: r.id,
      title: r.title ?? "App",
      subtitle: [r.extra === "draft" ? "Draft app" : "App", r.sub?.slice(0, 100)].filter(Boolean).join(" · "),
      href: `/dashboard/apps/${encodeURIComponent(slug)}`,
    };
  },
};
