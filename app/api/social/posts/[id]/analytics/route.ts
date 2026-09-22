// Marketr — social API: per-post analytics (milestone 20).
// GET /api/social/posts/[id]/analytics?projectId= → cached stats
// POST /api/social/posts/[id]/analytics { projectId } (editor+) → sync from Buffer

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createBufferPort } from "@/lib/social/buffer";
import { getBufferPort, syncAnalytics } from "@/lib/social/service";
import { ownedProject, readJson, requireEditor } from "../../../_lib";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const post = await prisma.socialPost.findFirst({ where: { id, projectId: project.id } });
  if (!post) return Response.json({ error: "Post not found" }, { status: 404 });
  return Response.json({
    stats: post.stats,
    statsSyncedAt: post.statsSyncedAt?.toISOString() ?? null,
  });
}

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
  if (!port) {
    return Response.json({ error: "No Buffer access token configured." }, { status: 400 });
  }
  try {
    const stats = await syncAnalytics(prisma, project.workspaceId, id, port, "user");
    return Response.json({ ok: true, stats });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Analytics sync failed." }, { status: 502 });
  }
}
