// Marketr — newsletter API: templates (milestone 19).
// GET /api/newsletter/templates?projectId= → template list
// POST /api/newsletter/templates { projectId, name, tiptap, brandKitId }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createTemplate } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, readJson } from "../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const templates = await prisma.newsletterTemplate.findMany({
    where: { projectId: project.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, brandKitId: true, isStarter: true, createdAt: true, updatedAt: true },
  });
  return Response.json({ templates });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  try {
    const row = await createTemplate(
      prisma,
      project.id,
      project.workspaceId,
      String(body.name ?? "Untitled"),
      body.tiptap,
      typeof body.brandKitId === "string" && body.brandKitId ? body.brandKitId : null,
    );
    return Response.json({ id: row.id }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to create template" }, { status: 400 });
  }
}
