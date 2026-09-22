// Marketr — social API: cancel a scheduled post (milestone 20).
// POST /api/social/posts/[id]/cancel { projectId } (editor+)
// Removes pending Buffer updates (best effort) and marks the post cancelled.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createBufferPort } from "@/lib/social/buffer";
import { cancelPost, getBufferPort } from "@/lib/social/service";
import { ownedProject, readJson, requireEditor } from "../../../_lib";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;

  const post = await prisma.socialPost.findFirst({ where: { id, projectId: project.id } });
  if (!post) return Response.json({ error: "Post not found" }, { status: 404 });

  const port = await getBufferPort(prisma, project.workspaceId, (t) => createBufferPort(t));
  try {
    await cancelPost(prisma, project.workspaceId, id, port, "user");
    return Response.json({ ok: true, status: "cancelled" });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Cancel failed." }, { status: 400 });
  }
}
