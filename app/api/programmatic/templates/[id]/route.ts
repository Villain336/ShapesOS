// Marketr — programmatic SEO template detail API (milestone 17).
// GET    /api/programmatic/templates/[id]?projectId=… (viewer+)
// PATCH  /api/programmatic/templates/[id] { projectId, …fields } (editor+)
// DELETE /api/programmatic/templates/[id]?projectId=… (editor+; cascades pages)

import { forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedProject, requireRole } from "../../util";
import { auditProgrammatic } from "@/lib/seo/programmatic-service";
import { normalizeUrlPattern, simpleBlocksToTiptap, type SimpleBlock } from "@/lib/seo/programmatic";

export const dynamic = "force-dynamic";

async function ownedTemplate(userId: string, projectId: unknown, templateId: string) {
  const project = await ownedProject(userId, projectId);
  if (!project) return null;
  const template = await prisma.programmaticTemplate.findFirst({
    where: { id: templateId, projectId: project.id },
  });
  if (!template) return null;
  return { project, template };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const owned = await ownedTemplate(user.id, req.nextUrl.searchParams.get("projectId"), id);
  if (!owned) return Response.json({ error: "Template not found" }, { status: 404 });
  if (!(await requireRole(user.id, owned.project.id, "viewer"))) return forbidden();
  return Response.json({ template: owned.template });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { id } = await params;
  const owned = await ownedTemplate(user.id, body.projectId, id);
  if (!owned) return Response.json({ error: "Template not found" }, { status: 404 });
  if (!(await requireRole(user.id, owned.project.id, "editor"))) return forbidden();

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return Response.json({ error: "Template name is required" }, { status: 400 });
    data.name = name;
  }
  if (body.urlPattern !== undefined) {
    const p = String(body.urlPattern).trim();
    if (!p.startsWith("/")) return Response.json({ error: "URL pattern must start with /" }, { status: 400 });
    data.urlPattern = normalizeUrlPattern(p);
  }
  if (body.titleTemplate !== undefined) data.titleTemplate = String(body.titleTemplate);
  if (body.descriptionTemplate !== undefined) data.descriptionTemplate = String(body.descriptionTemplate);
  if (body.contentBlocks !== undefined) {
    const cb = body.contentBlocks;
    if (Array.isArray(cb)) {
      data.contentBlocks = simpleBlocksToTiptap(cb as SimpleBlock[]);
    } else if (typeof cb === "object" && cb !== null && (cb as { type?: string }).type === "doc") {
      data.contentBlocks = cb;
    } else {
      return Response.json({ error: "contentBlocks must be a Tiptap doc or simple blocks" }, { status: 400 });
    }
  }
  if (body.minWordCount !== undefined) {
    const n = Math.floor(Number(body.minWordCount));
    if (!Number.isFinite(n) || n < 50 || n > 10000) {
      return Response.json({ error: "minWordCount must be between 50 and 10000" }, { status: 400 });
    }
    data.minWordCount = n;
  }
  if (body.duplicateRateCap !== undefined) {
    const n = Number(body.duplicateRateCap);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return Response.json({ error: "duplicateRateCap must be between 0 and 1" }, { status: 400 });
    }
    data.duplicateRateCap = n;
  }
  if (body.noindexUntilApproved !== undefined) {
    data.noindexUntilApproved = body.noindexUntilApproved === true;
  }

  const template = await prisma.programmaticTemplate.update({ where: { id }, data });
  await auditProgrammatic(owned.project.workspaceId, owned.project.id, "programmatic_template_updated",
    `Template updated: ${template.name}`).catch(() => {});
  return Response.json({ template: { id: template.id, name: template.name } });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const owned = await ownedTemplate(user.id, req.nextUrl.searchParams.get("projectId"), id);
  if (!owned) return Response.json({ error: "Template not found" }, { status: 404 });
  if (!(await requireRole(user.id, owned.project.id, "editor"))) return forbidden();

  const publishedCount = await prisma.programmaticPage.count({
    where: { templateId: id, status: "published" },
  });
  if (publishedCount > 0) {
    return Response.json(
      { error: `Template has ${publishedCount} published page(s); discard or unpublish them before deleting` },
      { status: 409 },
    );
  }
  await prisma.programmaticTemplate.delete({ where: { id } });
  await auditProgrammatic(owned.project.workspaceId, owned.project.id, "programmatic_template_deleted",
    `Template deleted: ${owned.template.name}`).catch(() => {});
  return Response.json({ ok: true });
}
