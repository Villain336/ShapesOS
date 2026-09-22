// Marketr — studio API: Canva connection status + disconnect (milestone 22).
// GET  /api/studio/canva/status?projectId= → { status }
// POST /api/studio/canva/disconnect { workspaceId } → { ok } (editor+)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createCanvaPort } from "@/lib/studio/canva";
import { disconnectCanva } from "@/lib/studio/service";
import { ownedWorkspace, readJson, requireWorkspaceEditor } from "../../_lib";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const ws = await ownedWorkspace(user.id, body.workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, ws.id);
  if (denied) return denied;
  await disconnectCanva(prisma, ws.id, createCanvaPort());
  return Response.json({ ok: true });
}
