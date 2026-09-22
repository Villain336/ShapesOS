// Marketr — newsletter API: subscriber lists (milestone 19).
// GET /api/newsletter/lists?projectId= → lists with subscriber counts
// POST /api/newsletter/lists { projectId, name, doubleOptIn }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createList } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, readJson, workspacePort } from "../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const lists = await prisma.newsletterList.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    include: {
      _count: {
        select: {
          subscribers: { where: { status: "subscribed" } },
        },
      },
    },
  });
  return Response.json({
    lists: lists.map((l) => ({
      id: l.id,
      name: l.name,
      doubleOptIn: l.doubleOptIn,
      subscribedCount: l._count.subscribers,
      createdAt: l.createdAt.toISOString(),
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
  // Segment creation is optional — a list works locally until a Resend key exists.
  const portResult = await workspacePort(project.workspaceId);
  const port = "port" in portResult ? portResult.port : null;
  try {
    const list = await createList(
      prisma,
      project.id,
      project.workspaceId,
      String(body.name ?? ""),
      body.doubleOptIn !== false,
      port,
    );
    return Response.json({ id: list.id }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to create list" }, { status: 400 });
  }
}
