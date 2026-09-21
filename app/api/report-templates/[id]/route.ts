// Marketr — single report template API (milestone 12).
// GET /api/report-templates/[id] · PATCH (editor+) · DELETE (editor+)

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";

const SCHEDULES = new Set(["manual", "weekly", "monthly"]);
const TYPES = new Set(["ranking", "custom"]);

function validTiptapDoc(content: unknown): boolean {
  return (
    !!content &&
    typeof content === "object" &&
    (content as { type?: string }).type === "doc" &&
    Array.isArray((content as { content?: unknown }).content)
  );
}

async function owned(userId: string, email: string | null | undefined, id: string) {
  const workspace = await getOrCreateWorkspace(userId, email);
  const template = await prisma.reportTemplate.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      brandKit: true,
      project: { select: { id: true, domain: true } },
    },
  });
  return { workspace, template };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { template } = await owned(user.id, user.email, id);
  if (!template) return Response.json({ error: "Template not found" }, { status: 404 });
  return Response.json({ template });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { workspace, template } = await owned(user.id, user.email, id);
  if (!template) return Response.json({ error: "Template not found" }, { status: 404 });
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: {
    name?: string;
    type?: string;
    content?: unknown;
    brandKitId?: string | null;
    projectId?: string | null;
    schedule?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.content !== undefined && !validTiptapDoc(body.content)) {
    return Response.json({ error: "content must be a Tiptap JSON document" }, { status: 400 });
  }
  if (body.type !== undefined && !TYPES.has(body.type)) {
    return Response.json({ error: "type must be ranking or custom" }, { status: 400 });
  }
  if (body.schedule !== undefined && !SCHEDULES.has(body.schedule)) {
    return Response.json({ error: "schedule must be manual, weekly, or monthly" }, { status: 400 });
  }
  if (body.brandKitId) {
    const kit = await prisma.brandKit.findFirst({ where: { id: body.brandKitId, workspaceId: workspace.id } });
    if (!kit) return Response.json({ error: "Brand kit not found" }, { status: 404 });
  }
  if (body.projectId) {
    const project = await prisma.project.findFirst({ where: { id: body.projectId, workspaceId: workspace.id } });
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const updated = await prisma.reportTemplate.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim().slice(0, 120) } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.content !== undefined ? { content: body.content as object } : {}),
      ...(body.brandKitId !== undefined ? { brandKitId: body.brandKitId || null } : {}),
      ...(body.projectId !== undefined ? { projectId: body.projectId || null } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
    },
  });
  return Response.json({ template: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { workspace, template } = await owned(user.id, user.email, id);
  if (!template) return Response.json({ error: "Template not found" }, { status: 404 });
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  await prisma.reportTemplate.delete({ where: { id } });
  return Response.json({ ok: true });
}
