// Marketr — studio API: Canva connection status (milestone 22).
// GET /api/studio/canva/status?projectId= → { status }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getCanvaStatus } from "@/lib/studio/service";
import { ownedProject } from "../../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const status = await getCanvaStatus(prisma, project.workspaceId);
  return Response.json({ status });
}
