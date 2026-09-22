// Marketr — programmatic SEO pages API (milestone 17).
// GET   /api/programmatic/pages?projectId=…[&status=][&templateId=][&q=] (viewer+)
// PATCH /api/programmatic/pages { projectId, pageIds, action:
//   "approve" | "publish" | "discard" } (editor+). Quality gates enforced
//   server-side; publish also regenerates the sitemap.

import { forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedProject, requireRole } from "../util";
import {
  approveProgrammaticPages,
  discardProgrammaticPages,
  publishProgrammaticPages,
} from "@/lib/seo/programmatic-service";
import { tiptapToHtml } from "@/lib/seo/programmatic";

export const dynamic = "force-dynamic";

const STATUSES = ["draft", "ready", "published", "discarded"] as const;

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireRole(user.id, project.id, "viewer"))) return forbidden();

  const status = req.nextUrl.searchParams.get("status");
  const templateId = req.nextUrl.searchParams.get("templateId");
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();

  const pages = await prisma.programmaticPage.findMany({
    where: {
      projectId: project.id,
      ...(status && (STATUSES as readonly string[]).includes(status) ? { status: status as (typeof STATUSES)[number] } : {}),
      ...(templateId ? { templateId } : {}),
      ...(q ? { url: { contains: q, mode: "insensitive" as const } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      template: { select: { id: true, name: true, minWordCount: true, duplicateRateCap: true } },
      dataset: { select: { id: true, name: true } },
    },
  });

  const counts = await prisma.programmaticPage.groupBy({
    by: ["status"],
    where: { projectId: project.id },
    _count: true,
  });

  return Response.json({
    pages: pages.map((p) => {
      const content = (p.content ?? {}) as {
        title?: string; description?: string; contentBlocks?: unknown;
        wordCount?: number; missingVariables?: string[];
      };
      return {
        id: p.id,
        url: p.url,
        slug: p.slug,
        status: p.status,
        title: content.title ?? "",
        description: content.description ?? "",
        wordCount: content.wordCount ?? 0,
        missingVariables: content.missingVariables ?? [],
        qualityFlags: p.qualityFlags,
        noindex: p.noindex,
        canonical: p.canonical,
        publishedUrl: p.publishedUrl,
        publishedAt: p.publishedAt,
        html: content.contentBlocks ? tiptapToHtml(content.contentBlocks) : "",
        template: p.template,
        dataset: p.dataset,
        rowIndex: p.rowIndex,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    }),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
  });
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { projectId?: string; pageIds?: string[]; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireRole(user.id, project.id, "editor"))) return forbidden();

  const pageIds = Array.isArray(body.pageIds)
    ? body.pageIds.filter((id): id is string => typeof id === "string")
    : [];
  if (pageIds.length === 0) return Response.json({ error: "pageIds is required" }, { status: 400 });
  if (pageIds.length > 1000) return Response.json({ error: "Max 1000 pages per batch" }, { status: 400 });

  const args = { workspaceId: project.workspaceId, projectId: project.id, pageIds, actor: "user" as const };
  try {
    if (body.action === "approve") return Response.json(await approveProgrammaticPages(args));
    if (body.action === "publish") return Response.json(await publishProgrammaticPages(args));
    if (body.action === "discard") return Response.json(await discardProgrammaticPages(args));
    return Response.json({ error: 'action must be "approve" | "publish" | "discard"' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Action failed" }, { status: 400 });
  }
}
