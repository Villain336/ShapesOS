// Marketr — newsletter API: send a broadcast now (milestone 19).
// POST /api/newsletter/broadcasts/[id]/send { projectId }
// Guardrails are enforced server-side in sendBroadcast(); failures are
// audit-logged and fire an M13 alert.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { sendBroadcast } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, readJson, workspacePort } from "../../../_lib";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const portResult = await workspacePort(project.workspaceId);
  if ("response" in portResult) return portResult.response;
  try {
    const { sent } = await sendBroadcast(prisma, id, project.workspaceId, project.id, portResult.port);
    return Response.json({ sent });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Send failed." }, { status: 400 });
  }
}
