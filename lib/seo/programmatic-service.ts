// Marketr — programmatic SEO orchestration (milestone 17).
//
// Batch generation, approve/publish/discard with server-side quality gates,
// sitemap regeneration, and audit logging. The pure substitution/hashing
// logic lives in ./programmatic.ts.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { renderSitemapXml } from "./sitemap";
import {
  GENERATE_CHUNK_SIZE,
  MAX_DATASET_ROWS,
  PREVIEW_DEFAULT_LIMIT,
  QUALITY_FLAGS,
  duplicateRate,
  evaluateGates,
  generatePage,
  resolveRowValues,
  templateVariables,
  tiptapToHtml,
  type GeneratedPage,
} from "./programmatic";

type AuditAction =
  | "programmatic_template_created"
  | "programmatic_template_updated"
  | "programmatic_template_deleted"
  | "programmatic_dataset_uploaded"
  | "programmatic_dataset_deleted"
  | "programmatic_pages_generated"
  | "programmatic_page_approved"
  | "programmatic_page_published"
  | "programmatic_page_discarded"
  | "programmatic_page_pushed";

/** Shared audit helper for the programmatic API routes. */
export async function auditProgrammatic(
  workspaceId: string,
  projectId: string,
  action: AuditAction,
  summary: string,
  actor: "user" | "system" = "user",
): Promise<void> {
  return audit(workspaceId, projectId, action, summary, actor);
}

async function audit(
  workspaceId: string,
  projectId: string,
  action: AuditAction,
  summary: string,
  actor: "user" | "system" = "user",
): Promise<void> {
  await prisma.fileChangeLog.create({
    data: {
      workspaceId,
      projectId,
      connectionId: null,
      filePath: "",
      actor,
      action,
      summary: summary.slice(0, 280),
    },
  });
}

interface TemplateRow {
  id: string;
  projectId: string;
  urlPattern: string;
  titleTemplate: string;
  descriptionTemplate: string;
  contentBlocks: unknown;
  minWordCount: number;
  duplicateRateCap: number;
  noindexUntilApproved: boolean;
}

async function loadTemplate(projectId: string, templateId: string): Promise<TemplateRow | null> {
  const t = await prisma.programmaticTemplate.findFirst({
    where: { id: templateId, projectId },
  });
  if (!t) return null;
  return {
    id: t.id,
    projectId: t.projectId,
    urlPattern: t.urlPattern,
    titleTemplate: t.titleTemplate,
    descriptionTemplate: t.descriptionTemplate,
    contentBlocks: t.contentBlocks as unknown,
    minWordCount: t.minWordCount,
    duplicateRateCap: t.duplicateRateCap,
    noindexUntilApproved: t.noindexUntilApproved,
  };
}

interface DatasetRow {
  id: string;
  projectId: string;
  columns: string[];
  rows: Record<string, string>[];
  columnMapping: Record<string, string>;
}

async function loadDataset(projectId: string, datasetId: string): Promise<DatasetRow | null> {
  const d = await prisma.programmaticDataset.findFirst({
    where: { id: datasetId, projectId },
  });
  if (!d) return null;
  const rawRows = d.rows as unknown;
  const rows = Array.isArray(rawRows) ? (rawRows as Record<string, string>[]) : [];
  return {
    id: d.id,
    projectId: d.projectId,
    columns: Array.isArray(d.schema) ? (d.schema as string[]) : [],
    rows,
    columnMapping: (d.columnMapping as Record<string, string> | null) ?? {},
  };
}

function siteOrigin(domain: string): string {
  const d = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${d}`;
}

// ---------------------------------------------------------------------------
// Preview (no DB writes)
// ---------------------------------------------------------------------------

export interface ProgrammaticPreviewPage extends GeneratedPage {
  rowIndex: number;
  html: string;
  slugCollision: boolean;
  status: "draft";
}

export async function previewProgrammaticPages(args: {
  projectId: string;
  templateId: string;
  datasetId: string;
  limit?: number;
}): Promise<{ pages: ProgrammaticPreviewPage[]; totalRows: number; variables: { name: string; fallback?: string }[] }> {
  const [template, dataset, project] = await Promise.all([
    loadTemplate(args.projectId, args.templateId),
    loadDataset(args.projectId, args.datasetId),
    prisma.project.findUnique({ where: { id: args.projectId }, select: { domain: true } }),
  ]);
  if (!template) throw new Error("Template not found");
  if (!dataset) throw new Error("Dataset not found");
  if (!project) throw new Error("Project not found");

  const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? PREVIEW_DEFAULT_LIMIT)));
  const vars = templateVariables(template);
  const existingSlugs = new Set(
    (await prisma.programmaticPage.findMany({
      where: { templateId: template.id },
      select: { slug: true },
    })).map((p) => p.slug),
  );
  const seen = new Set<string>();
  const pages: ProgrammaticPreviewPage[] = [];
  const origin = siteOrigin(project.domain);

  for (let i = 0; i < Math.min(limit, dataset.rows.length); i++) {
    const values = resolveRowValues(
      vars.map((v) => v.name),
      dataset.columns,
      dataset.rows[i],
      dataset.columnMapping,
    );
    const gen = generatePage(template, values, origin);
    const slugCollision = existingSlugs.has(gen.slug) || seen.has(gen.slug);
    seen.add(gen.slug);
    const flags = slugCollision && !gen.flags.includes(QUALITY_FLAGS.slugCollision)
      ? [...gen.flags, QUALITY_FLAGS.slugCollision]
      : gen.flags;
    pages.push({
      ...gen,
      flags,
      rowIndex: i,
      html: tiptapToHtml(gen.contentBlocks),
      slugCollision,
      status: "draft",
    });
  }
  return { pages, totalRows: dataset.rows.length, variables: vars };
}

// ---------------------------------------------------------------------------
// Batch generation (chunked, idempotent on (templateId, slug))
// ---------------------------------------------------------------------------

export interface GenerateResult {
  total: number;
  created: number;
  updated: number;
  skippedPublished: number;
  skippedCollisions: { rowIndex: number; slug: string }[];
  flagged: number;
}

export async function generateProgrammaticPages(args: {
  workspaceId: string;
  projectId: string;
  templateId: string;
  datasetId: string;
  actor?: "user" | "system";
}): Promise<GenerateResult> {
  const [template, dataset, project] = await Promise.all([
    loadTemplate(args.projectId, args.templateId),
    loadDataset(args.projectId, args.datasetId),
    prisma.project.findUnique({ where: { id: args.projectId }, select: { domain: true } }),
  ]);
  if (!template) throw new Error("Template not found");
  if (!dataset) throw new Error("Dataset not found");
  if (!project) throw new Error("Project not found");

  const rows = dataset.rows.slice(0, MAX_DATASET_ROWS);
  const vars = templateVariables(template);
  const varNames = vars.map((v) => v.name);
  const origin = siteOrigin(project.domain);

  // Existing pages for this template: slug → { id, datasetId, rowIndex, status }.
  const existing = await prisma.programmaticPage.findMany({
    where: { templateId: template.id },
    select: { id: true, slug: true, datasetId: true, rowIndex: true, status: true },
  });
  const existingBySlug = new Map(existing.map((p) => [p.slug, p]));
  // Existing hashes (non-discarded) for duplicate-content detection.
  const existingHashes = new Set(
    (await prisma.programmaticPage.findMany({
      where: { templateId: template.id, status: { not: "discarded" } },
      select: { contentHash: true },
    }))
      .map((p) => p.contentHash)
      .filter((h): h is string => !!h),
  );

  // First pass: generate everything in memory (chunked for large sets).
  const generated: { rowIndex: number; page: GeneratedPage }[] = [];
  for (let start = 0; start < rows.length; start += GENERATE_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + GENERATE_CHUNK_SIZE);
    for (let j = 0; j < chunk.length; j++) {
      const rowIndex = start + j;
      const values = resolveRowValues(varNames, dataset.columns, chunk[j], dataset.columnMapping);
      generated.push({ rowIndex, page: generatePage(template, values, origin) });
    }
  }

  // Duplicate-content flags across (existing ∪ batch).
  const hashCounts = new Map<string, number>();
  for (const h of existingHashes) hashCounts.set(h, (hashCounts.get(h) ?? 0) + 1);
  for (const g of generated) hashCounts.set(g.page.contentHash, (hashCounts.get(g.page.contentHash) ?? 0) + 1);
  for (const g of generated) {
    if ((hashCounts.get(g.page.contentHash) ?? 0) > 1 && !g.page.flags.includes(QUALITY_FLAGS.duplicateContent)) {
      g.page.flags.push(QUALITY_FLAGS.duplicateContent);
    }
  }

  const result: GenerateResult = {
    total: generated.length,
    created: 0,
    updated: 0,
    skippedPublished: 0,
    skippedCollisions: [],
    flagged: 0,
  };
  const seenSlugs = new Set<string>();

  for (const { rowIndex, page } of generated) {
    const flags = [...page.flags];
    const prior = existingBySlug.get(page.slug);
    const isRegeneration = !!prior && prior.datasetId === dataset.id && prior.rowIndex === rowIndex;

    if (prior && !isRegeneration) {
      // Genuine slug collision with a page from another dataset/row.
      result.skippedCollisions.push({ rowIndex, slug: page.slug });
      continue;
    }
    if (seenSlugs.has(page.slug)) {
      // Two rows in this batch produced the same slug.
      result.skippedCollisions.push({ rowIndex, slug: page.slug });
      continue;
    }
    seenSlugs.add(page.slug);
    if (prior && prior.status === "published") {
      // Published pages are immutable via regenerate.
      result.skippedPublished += 1;
      continue;
    }
    if (flags.length > 0) result.flagged += 1;

    const content: Prisma.InputJsonObject = {
      title: page.title,
      description: page.description,
      contentBlocks: page.contentBlocks as unknown as Prisma.InputJsonValue,
      wordCount: page.wordCount,
      missingVariables: page.missingVariables,
    };
    const data = {
      projectId: args.projectId,
      templateId: template.id,
      datasetId: dataset.id,
      rowIndex,
      url: page.url,
      slug: page.slug,
      content,
      contentHash: page.contentHash,
      noindex: template.noindexUntilApproved,
      canonical: page.canonical,
      qualityFlags: flags,
    };
    if (prior) {
      await prisma.programmaticPage.update({
        where: { id: prior.id },
        data: { ...data, status: prior.status === "ready" ? "ready" : "draft" },
      });
      result.updated += 1;
    } else {
      await prisma.programmaticPage.create({ data: { ...data, status: "draft" } });
      result.created += 1;
    }
  }

  await audit(
    args.workspaceId,
    args.projectId,
    "programmatic_pages_generated",
    `Generated ${result.created} + updated ${result.updated} pages (template ${template.id}, dataset ${dataset.id}); ${result.skippedCollisions.length} slug collisions, ${result.flagged} flagged`,
    args.actor ?? "user",
  ).catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// Approve / publish / discard (server-side gates)
// ---------------------------------------------------------------------------

export interface PageActionResult {
  changed: string[];
  blocked: { id: string; url: string; reasons: string[] }[];
}

export async function templateDuplicateRate(templateId: string): Promise<number> {
  const hashes = (
    await prisma.programmaticPage.findMany({
      where: { templateId, status: { not: "discarded" } },
      select: { contentHash: true },
    })
  ).map((p) => p.contentHash);
  return duplicateRate(hashes);
}

export async function approveProgrammaticPages(args: {
  workspaceId: string;
  projectId: string;
  pageIds: string[];
  actor?: "user" | "system";
}): Promise<PageActionResult> {
  const result: PageActionResult = { changed: [], blocked: [] };
  for (const id of args.pageIds) {
    const page = await prisma.programmaticPage.findFirst({
      where: { id, projectId: args.projectId },
      include: { template: true },
    });
    if (!page) {
      result.blocked.push({ id, url: "", reasons: ["Page not found"] });
      continue;
    }
    if (page.status !== "draft") {
      result.blocked.push({ id, url: page.url, reasons: [`Only draft pages can be approved (status: ${page.status})`] });
      continue;
    }
    const content = (page.content ?? {}) as { missingVariables?: string[]; wordCount?: number };
    const gates = evaluateGates({
      flags: Array.isArray(page.qualityFlags) ? (page.qualityFlags as string[]) : [],
      missingVariables: content.missingVariables ?? [],
      wordCount: content.wordCount ?? 0,
      minWordCount: page.template.minWordCount,
      templateDuplicateRate: 0,
      duplicateRateCap: page.template.duplicateRateCap,
      checkDuplicateRate: false,
    });
    if (!gates.pass) {
      result.blocked.push({ id, url: page.url, reasons: gates.reasons });
      continue;
    }
    await prisma.programmaticPage.update({ where: { id }, data: { status: "ready" } });
    result.changed.push(id);
  }
  if (result.changed.length > 0) {
    await audit(args.workspaceId, args.projectId, "programmatic_page_approved",
      `Approved ${result.changed.length} programmatic page(s) to ready`, args.actor ?? "user").catch(() => {});
  }
  return result;
}

export async function publishProgrammaticPages(args: {
  workspaceId: string;
  projectId: string;
  pageIds: string[];
  actor?: "user" | "system";
}): Promise<PageActionResult> {
  const result: PageActionResult = { changed: [], blocked: [] };
  // Template-wide duplicate rate, computed once per template in this batch.
  const dupRateCache = new Map<string, number>();
  for (const id of args.pageIds) {
    const page = await prisma.programmaticPage.findFirst({
      where: { id, projectId: args.projectId },
      include: { template: true },
    });
    if (!page) {
      result.blocked.push({ id, url: "", reasons: ["Page not found"] });
      continue;
    }
    if (page.status === "published") {
      result.blocked.push({ id, url: page.url, reasons: ["Already published"] });
      continue;
    }
    if (page.status !== "ready" && page.status !== "draft") {
      result.blocked.push({ id, url: page.url, reasons: [`Cannot publish from status: ${page.status}`] });
      continue;
    }
    let dupRate = dupRateCache.get(page.templateId);
    if (dupRate === undefined) {
      dupRate = await templateDuplicateRate(page.templateId);
      dupRateCache.set(page.templateId, dupRate);
    }
    const content = (page.content ?? {}) as { missingVariables?: string[]; wordCount?: number };
    const gates = evaluateGates({
      flags: Array.isArray(page.qualityFlags) ? (page.qualityFlags as string[]) : [],
      missingVariables: content.missingVariables ?? [],
      wordCount: content.wordCount ?? 0,
      minWordCount: page.template.minWordCount,
      templateDuplicateRate: dupRate,
      duplicateRateCap: page.template.duplicateRateCap,
      checkDuplicateRate: true,
    });
    if (!gates.pass) {
      result.blocked.push({ id, url: page.url, reasons: gates.reasons });
      continue;
    }
    await prisma.programmaticPage.update({
      where: { id },
      data: {
        status: "published",
        noindex: false,
        publishedUrl: page.canonical ?? page.url,
        publishedAt: new Date(),
      },
    });
    result.changed.push(id);
  }
  if (result.changed.length > 0) {
    await regenerateSitemap(args.projectId).catch(() => {});
    await audit(args.workspaceId, args.projectId, "programmatic_page_published",
      `Published ${result.changed.length} programmatic page(s); sitemap regenerated`, args.actor ?? "user").catch(() => {});
  }
  return result;
}

export async function discardProgrammaticPages(args: {
  workspaceId: string;
  projectId: string;
  pageIds: string[];
  actor?: "user" | "system";
}): Promise<PageActionResult> {
  const result: PageActionResult = { changed: [], blocked: [] };
  for (const id of args.pageIds) {
    const page = await prisma.programmaticPage.findFirst({
      where: { id, projectId: args.projectId },
      select: { id: true, url: true, status: true },
    });
    if (!page) {
      result.blocked.push({ id, url: "", reasons: ["Page not found"] });
      continue;
    }
    if (page.status === "published") {
      result.blocked.push({ id, url: page.url, reasons: ["Published pages cannot be discarded"] });
      continue;
    }
    await prisma.programmaticPage.update({ where: { id }, data: { status: "discarded" } });
    result.changed.push(id);
  }
  if (result.changed.length > 0) {
    await audit(args.workspaceId, args.projectId, "programmatic_page_discarded",
      `Discarded ${result.changed.length} programmatic page(s)`, args.actor ?? "user").catch(() => {});
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

function sitemapStorageDir(): string {
  return process.env.SITEMAP_STORAGE_DIR ?? join(process.cwd(), ".data", "sitemaps");
}

export async function buildSitemapXml(projectId: string): Promise<{ xml: string; count: number }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { domain: true },
  });
  if (!project) throw new Error("Project not found");
  const pages = await prisma.programmaticPage.findMany({
    where: { projectId, status: "published" },
    orderBy: { url: "asc" },
    select: { canonical: true, url: true, publishedAt: true, updatedAt: true },
  });
  const origin = siteOrigin(project.domain);
  // Phase 11 (seotools): one XML renderer for programmatic and site sitemaps.
  const xml = renderSitemapXml(
    pages.map((p) => ({
      loc: p.canonical ?? `${origin}${p.url}`,
      lastmod: (p.publishedAt ?? p.updatedAt).toISOString().slice(0, 10),
    })),
  );
  return { xml, count: pages.length };
}

/** Regenerate the project's sitemap.xml after publish. Stored on disk. */
export async function regenerateSitemap(projectId: string): Promise<{ path: string; count: number }> {
  const { xml, count } = await buildSitemapXml(projectId);
  const dir = sitemapStorageDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${projectId}.xml`);
  await writeFile(path, xml, "utf8");
  return { path, count };
}
