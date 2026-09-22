// Marketr — newsletter API: single template (milestone 19).
// GET /api/newsletter/templates/[id]?projectId= → full template (with tiptap)
// PATCH → { name?, tiptap?, brandKitId? }
// DELETE → remove

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { deleteTemplate, updateTemplate } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, readJson } from "../../_lib";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const template = await prisma.newsletterTemplate.findFirst({
    where: { id, projectId: project.id },
    include: { brandKit: { select: { id: true, name: true } } },
  });
  if (!template) return Response.json({ error: "Template not found" }, { status: 404 });
  return Response.json({ template });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  try {
    const row = await updateTemplate(prisma, id, project.id, project.workspaceId, {
      name: typeof body.name === "string" ? body.name : undefined,
      tiptap: body.tiptap,
      brandKitId:
        body.brandKitId === null || typeof body.brandKitId === "string" ? body.brandKitId || null : undefined,
    });
    return Response.json({ id: row.id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to update template" }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJson(req);
  const projectId = body.projectId ?? new URL(req.url).searchParams.get("projectId");
  const project = await ownedProject(user.id, projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  try {
    await deleteTemplate(prisma, id, project.id, project.workspaceId);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to delete template" }, { status: 400 });
  }
}
