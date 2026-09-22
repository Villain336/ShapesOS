// Marketr — programmatic SEO templates API (milestone 17).
// GET  /api/programmatic/templates?projectId=… → templates with page counts (viewer+).
// POST /api/programmatic/templates { projectId, name, urlPattern, titleTemplate,
//   descriptionTemplate, contentBlocks, minWordCount?, duplicateRateCap?,
//   noindexUntilApproved? } → create (editor+).

import { forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedProject, requireRole } from "../util";
import { auditProgrammatic } from "@/lib/seo/programmatic-service";
import {
  normalizeUrlPattern,
  simpleBlocksToTiptap,
  templateVariables,
  type SimpleBlock,
} from "@/lib/seo/programmatic";

export const dynamic = "force-dynamic";

function isTiptapDoc(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: unknown }).type === "doc" &&
    Array.isArray((v as { content?: unknown }).content)
  );
}

function coerceContentBlocks(input: unknown): object | null {
  if (isTiptapDoc(input)) return input as object;
  // Accept the template editor's simple blocks: [{ type, text }].
  if (Array.isArray(input)) {
    const blocks = (input as unknown[]).filter(
      (b): b is SimpleBlock =>
        typeof b === "object" &&
        b !== null &&
        ["paragraph", "h1", "h2", "h3", "bullet"].includes((b as { type: string }).type) &&
        typeof (b as { text: string }).text === "string",
    );
    if (blocks.length > 0 || (input as unknown[]).length === 0) {
      return simpleBlocksToTiptap(blocks);
    }
  }
  return null;
}

function validateTemplateBody(body: Record<string, unknown>): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const urlPattern = typeof body.urlPattern === "string" ? body.urlPattern.trim() : "";
  const titleTemplate = typeof body.titleTemplate === "string" ? body.titleTemplate : "";
  const descriptionTemplate = typeof body.descriptionTemplate === "string" ? body.descriptionTemplate : "";
  if (!name) return { ok: false, error: "Template name is required" };
  if (!urlPattern) return { ok: false, error: "URL pattern is required (e.g. /services/{{city}}/{{service}})" };
  if (!urlPattern.startsWith("/")) return { ok: false, error: "URL pattern must start with /" };
  const contentBlocks = coerceContentBlocks(body.contentBlocks);
  if (!contentBlocks) return { ok: false, error: "contentBlocks must be a Tiptap doc or an array of { type, text } blocks" };

  const minWordCount =
    body.minWordCount === undefined ? 300 : Math.floor(Number(body.minWordCount));
  if (!Number.isFinite(minWordCount) || minWordCount < 50 || minWordCount > 10000) {
    return { ok: false, error: "minWordCount must be between 50 and 10000" };
  }
  const duplicateRateCap = body.duplicateRateCap === undefined ? 0.05 : Number(body.duplicateRateCap);
  if (!Number.isFinite(duplicateRateCap) || duplicateRateCap < 0 || duplicateRateCap > 1) {
    return { ok: false, error: "duplicateRateCap must be between 0 and 1" };
  }
  const noindexUntilApproved = body.noindexUntilApproved === undefined ? true : body.noindexUntilApproved === true;

  return {
    ok: true,
    data: {
      name,
      urlPattern: normalizeUrlPattern(urlPattern),
      titleTemplate,
      descriptionTemplate,
      contentBlocks,
      minWordCount,
      duplicateRateCap,
      noindexUntilApproved,
    },
  };
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireRole(user.id, project.id, "viewer"))) return forbidden();

  const templates = await prisma.programmaticTemplate.findMany({
    where: { projectId: project.id },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { pages: true } },
      pages: {
        select: { status: true },
      },
    },
  });
  return Response.json({
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      urlPattern: t.urlPattern,
      titleTemplate: t.titleTemplate,
      descriptionTemplate: t.descriptionTemplate,
      contentBlocks: t.contentBlocks,
      minWordCount: t.minWordCount,
      duplicateRateCap: t.duplicateRateCap,
      noindexUntilApproved: t.noindexUntilApproved,
      variables: templateVariables({
        urlPattern: t.urlPattern,
        titleTemplate: t.titleTemplate,
        descriptionTemplate: t.descriptionTemplate,
        contentBlocks: t.contentBlocks,
      }),
      pageCounts: {
        total: t._count.pages,
        draft: t.pages.filter((p) => p.status === "draft").length,
        ready: t.pages.filter((p) => p.status === "ready").length,
        published: t.pages.filter((p) => p.status === "published").length,
      },
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireRole(user.id, project.id, "editor"))) return forbidden();

  const validated = validateTemplateBody(body);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
  const d = validated.data;

  const template = await prisma.programmaticTemplate.create({
    data: {
      projectId: project.id,
      name: d.name as string,
      urlPattern: d.urlPattern as string,
      titleTemplate: d.titleTemplate as string,
      descriptionTemplate: d.descriptionTemplate as string,
      contentBlocks: d.contentBlocks as object,
      minWordCount: d.minWordCount as number,
      duplicateRateCap: d.duplicateRateCap as number,
      noindexUntilApproved: d.noindexUntilApproved as boolean,
    },
  });
  await auditProgrammatic(project.workspaceId, project.id, "programmatic_template_created",
    `Template created: ${template.name}`).catch(() => {});
  return Response.json({ template: { id: template.id, name: template.name } }, { status: 201 });
}
