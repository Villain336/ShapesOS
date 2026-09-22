// Marketr — social API: channel list + sync (milestone 20).
// GET /api/social/channels?projectId= → channels
// POST /api/social/channels { projectId } → sync from Buffer (editor+)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { syncChannels } from "@/lib/social/service";
import { ownedProject, readJson, requireEditor, workspacePort } from "../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const rows = await prisma.socialChannel.findMany({
    where: { projectId: project.id },
    orderBy: [{ service: "asc" }, { handle: "asc" }],
  });
  return Response.json({
    channels: rows.map((r) => ({
      id: r.id,
      bufferProfileId: r.bufferProfileId,
      service: r.service,
      handle: r.handle,
      enabled: r.enabled,
      updatedAt: r.updatedAt.toISOString(),
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
  const ported = await workspacePort(project.workspaceId);
  if ("response" in ported) return ported.response;
  try {
    const channels = await syncChannels(prisma, project.id, project.workspaceId, ported.port, "user");
    return Response.json({ channels });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Channel sync failed." },
      { status: 502 },
    );
  }
}
