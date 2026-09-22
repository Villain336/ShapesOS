// Marketr — social API: post drafts (milestone 20).
// GET /api/social/posts?projectId=&status=&service= → posts (newest first)
// POST /api/social/posts { projectId, content, services, scheduledFor? } → draft

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createPost, sanitizeContent } from "@/lib/social/service";
import { CHANNEL_DEFS, type SocialService } from "@/lib/social/channels";
import { ownedProject, readJson, requireEditor } from "../_lib";

function serialize(p: {
  id: string;
  content: unknown;
  services: string[];
  scheduledFor: Date | null;
  status: string;
  bufferUpdateIds: unknown;
  attempts: number;
  nextAttemptAt: Date | null;
  error: string | null;
  stats: unknown;
  statsSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const content = sanitizeContent(p.content);
  return {
    id: p.id,
    content,
    services: p.services,
    serviceLabels: p.services.map((s) => CHANNEL_DEFS[s as SocialService]?.label ?? s),
    scheduledFor: p.scheduledFor?.toISOString() ?? null,
    status: p.status,
    bufferUpdateIds: p.bufferUpdateIds,
    attempts: p.attempts,
    nextAttemptAt: p.nextAttemptAt?.toISOString() ?? null,
    error: p.error,
    stats: p.stats,
    statsSyncedAt: p.statsSyncedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const project = await ownedProject(user.id, sp.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const status = sp.get("status");
  const service = sp.get("service");
  const rows = await prisma.socialPost.findMany({
    where: {
      projectId: project.id,
      ...(status ? { status: status as never } : {}),
      ...(service ? { services: { has: service } } : {}),
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
  return Response.json({ posts: rows.map(serialize) });
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
    const post = await createPost(
      prisma,
      project.workspaceId,
      project.id,
      {
        content: body.content,
        services: Array.isArray(body.services) ? body.services : [],
        scheduledFor: typeof body.scheduledFor === "string" ? body.scheduledFor : null,
      },
      "user",
    );
    return Response.json({ post: serialize(post) }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to create post." }, { status: 400 });
  }
}
