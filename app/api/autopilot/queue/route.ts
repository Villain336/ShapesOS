// Marketr — content autopilot API: approval queue (milestone 18).
// GET /api/autopilot/queue?projectId=&status=pending|approved|rejected|published|killed

import { accessibleWorkspaceWhere } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { AUTOPILOT_ITEM_STATUSES } from "@/lib/seo/autopilot";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const project = await prisma.project.findFirst({
    where: { id: params.get("projectId") ?? "", workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const status = params.get("status");
  const items = await prisma.autopilotItem.findMany({
    where: {
      projectId: project.id,
      ...(status && (AUTOPILOT_ITEM_STATUSES as readonly string[]).includes(status) ? { status: status as never } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { rule: { select: { id: true, name: true } } },
  });
  return Response.json({ items });
}
