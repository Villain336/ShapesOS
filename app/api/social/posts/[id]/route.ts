// Marketr — social API: single post (milestone 20).
// GET /api/social/posts/[id]?projectId= → detail
// PATCH → edit draft (editor+) — drafts only
// DELETE → delete draft/failed (editor+)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { deletePost, sanitizeContent, updatePost } from "@/lib/social/service";
import { ownedProject, readJson, requireEditor } from "../../_lib";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const post = await prisma.socialPost.findFirst({ where: { id, projectId: project.id } });
  if (!post) return Response.json({ error: "Post not found" }, { status: 404 });
  return Response.json({
    post: {
      id: post.id,
      content: sanitizeContent(post.content),
      services: post.services,
      scheduledFor: post.scheduledFor?.toISOString() ?? null,
      status: post.status,
      bufferUpdateIds: post.bufferUpdateIds,
      attempts: post.attempts,
      nextAttemptAt: post.nextAttemptAt?.toISOString() ?? null,
      error: post.error,
      stats: post.stats,
      statsSyncedAt: post.statsSyncedAt?.toISOString() ?? null,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
    },
  });
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
  const existing = await prisma.socialPost.findFirst({ where: { id, projectId: project.id } });
  if (!existing) return Response.json({ error: "Post not found" }, { status: 404 });
  try {
    const updated = await updatePost(
      prisma,
      project.workspaceId,
      id,
      {
        content: body.content,
        services: Array.isArray(body.services) ? body.services : undefined,
        scheduledFor: body.scheduledFor === null ? null : typeof body.scheduledFor === "string" ? body.scheduledFor : undefined,
      },
      "user",
    );
    return Response.json({ ok: true, post: { id: updated.id, status: updated.status } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Update failed." }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const existing = await prisma.socialPost.findFirst({ where: { id, projectId: project.id } });
  if (!existing) return Response.json({ error: "Post not found" }, { status: 404 });
  try {
    await deletePost(prisma, project.workspaceId, id, "user");
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Delete failed." }, { status: 400 });
  }
}
