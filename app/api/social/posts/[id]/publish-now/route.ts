// Marketr — social API: publish now (milestone 20).
// POST /api/social/posts/[id]/publish-now { projectId } (editor+)
// Dispatches to Buffer with now=true, then refreshes status so a post Buffer
// published immediately shows as sent without waiting for the cron.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createBufferPort } from "@/lib/social/buffer";
import { dispatchPost, getBufferPort, refreshPostStatus } from "@/lib/social/service";
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
  if (post.status !== "draft" && post.status !== "failed") {
    return Response.json({ error: `Only draft or failed posts can be published (status: ${post.status}).` }, { status: 400 });
  }

  const port = await getBufferPort(prisma, project.workspaceId, (t) => createBufferPort(t));
  if (!port) {
    return Response.json({ error: "No Buffer access token configured — connect Buffer in social settings first." }, { status: 400 });
  }

  try {
    await dispatchPost(prisma, project.workspaceId, project.id, id, port, { now: true, actor: "user" });
    const refreshed = await refreshPostStatus(prisma, project.workspaceId, id, port, "user");
    return Response.json({ ok: true, status: refreshed.status });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Publish failed." }, { status: 502 });
  }
}
