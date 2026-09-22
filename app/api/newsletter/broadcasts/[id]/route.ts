// Marketr — newsletter API: single broadcast (milestone 19).
// GET /api/newsletter/broadcasts/[id]?projectId= → detail (no raw snapshot HTML)
// DELETE → cancel (draft/scheduled only)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { cancelBroadcast } from "@/lib/newsletter/service";
import { ownedProject, requireEditor } from "../../_lib";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const b = await prisma.newsletterBroadcast.findFirst({
    where: { id, projectId: project.id },
    include: {
      list: { select: { id: true, name: true } },
      domain: { select: { id: true, domain: true, status: true } },
    },
  });
  if (!b) return Response.json({ error: "Broadcast not found" }, { status: 404 });
  return Response.json({
    broadcast: {
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
    },
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  try {
    await cancelBroadcast(prisma, id, project.workspaceId, project.id);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to cancel broadcast." }, { status: 400 });
  }
}
