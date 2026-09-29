// Marketr — Phase 16 slice 9: branded report engine API.
// GET /api/reports/send-approvals/[id]  → one send approval (any member)

import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await params;

  const approval = await prisma.reportSendApproval.findFirst({
    where: { id, workspaceId: workspace.id },
    include: { brandKit: { select: { id: true, name: true } } },
  });
  if (!approval) return Response.json({ error: "Report approval not found" }, { status: 404 });
  return Response.json({ approval });
}
