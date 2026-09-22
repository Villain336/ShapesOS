// Marketr — social API: enable/disable a channel (milestone 20).
// PATCH /api/social/channels/[id]?projectId= { enabled }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { setChannelEnabled } from "@/lib/social/service";
import { ownedProject, readJson, requireEditor } from "../../_lib";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const channel = await prisma.socialChannel.findFirst({ where: { id, projectId: project.id } });
  if (!channel) return Response.json({ error: "Channel not found" }, { status: 404 });
  const body = await readJson(req);
  await setChannelEnabled(prisma, project.workspaceId, id, body.enabled !== false, "user");
  return Response.json({ ok: true, enabled: body.enabled !== false });
}
