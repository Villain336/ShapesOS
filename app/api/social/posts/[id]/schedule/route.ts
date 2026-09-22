// Marketr — social API: schedule a post (milestone 20).
// POST /api/social/posts/[id]/schedule { projectId, scheduledFor } (editor+)
// Sets status=scheduled; if the time is already due, dispatches to Buffer
// immediately (with retry bookkeeping). Otherwise the cron sweep dispatches
// it when due.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { attemptDispatch } from "@/lib/social/service";
import { createBufferPort } from "@/lib/social/buffer";
import { getBufferPort } from "@/lib/social/service";
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
    return Response.json({ error: `Only draft or failed posts can be scheduled (status: ${post.status}).` }, { status: 400 });
  }
  if (typeof body.scheduledFor !== "string" || !body.scheduledFor) {
    return Response.json({ error: "scheduledFor is required." }, { status: 400 });
  }
  const scheduledFor = new Date(body.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    return Response.json({ error: "scheduledFor is not a valid date." }, { status: 400 });
  }

  const port = await getBufferPort(prisma, project.workspaceId, (t) => createBufferPort(t));
  if (!port) {
    return Response.json({ error: "No Buffer access token configured — connect Buffer in social settings first." }, { status: 400 });
  }

  // Mark scheduled first (guardrail checks happen inside dispatch).
  const row = await prisma.socialPost.update({
    where: { id },
    data: { scheduledFor, status: "scheduled", error: null },
    include: { project: { select: { workspaceId: true } } },
  });

  // Due now or in the past → dispatch immediately; otherwise the cron sweep
  // picks it up at the scheduled time.
  let outcome: { outcome: string; error?: string } = { outcome: "queued" };
  if (scheduledFor <= new Date()) {
    outcome = await attemptDispatch(prisma, project.workspaceId, row, port, "user");
  }
  return Response.json({ ok: true, status: "scheduled", scheduledFor: scheduledFor.toISOString(), dispatch: outcome });
}
