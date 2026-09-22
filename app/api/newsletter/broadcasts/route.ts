// Marketr — newsletter API: broadcasts (milestone 19).
// GET /api/newsletter/broadcasts?projectId= → broadcast list
// POST /api/newsletter/broadcasts { projectId, subject, listId, domainId, templateId?|tiptap?, brandKitId?, scheduledAt? }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createBroadcast } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, readJson } from "../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const broadcasts = await prisma.newsletterBroadcast.findMany({
    where: { projectId: project.id },
    orderBy: { updatedAt: "desc" },
    include: {
      list: { select: { id: true, name: true } },
      domain: { select: { id: true, domain: true, status: true } },
    },
  });
  return Response.json({
    broadcasts: broadcasts.map((b) => ({
      id: b.id,
      subject: b.subject,
      status: b.status,
      scheduledAt: b.scheduledAt?.toISOString() ?? null,
      testSentAt: b.testSentAt?.toISOString() ?? null,
      testSentTo: b.testSentTo,
      stats: b.stats,
      error: b.error,
      list: b.list,
      domain: b.domain,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    })),
  });
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
    const b = await createBroadcast(prisma, project.id, project.workspaceId, {
      subject: String(body.subject ?? ""),
      listId: String(body.listId ?? ""),
      domainId: String(body.domainId ?? ""),
      templateId: typeof body.templateId === "string" ? body.templateId : undefined,
      tiptap: body.tiptap,
      brandKitId: typeof body.brandKitId === "string" && body.brandKitId ? body.brandKitId : null,
      scheduledAt: typeof body.scheduledAt === "string" && body.scheduledAt ? body.scheduledAt : null,
    });
    return Response.json({ id: b.id }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to create broadcast." }, { status: 400 });
  }
}
