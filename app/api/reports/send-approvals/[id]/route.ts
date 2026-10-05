// Marketr — Phase 16 slice 9: branded report engine API.
// GET /api/reports/send-approvals/[id]  → one send approval (any member)

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await params;

  // report_send_approvals is FORCE-RLS: read inside the workspace scope.
  const approval = await withWorkspaceScope(workspace.id, (tx) =>
    tx.reportSendApproval.findFirst({
      where: { id, workspaceId: workspace.id },
      include: { brandKit: { select: { id: true, name: true } } },
    }),
  );
  if (!approval) return Response.json({ error: "Report approval not found" }, { status: 404 });
  return Response.json({ approval });
}
