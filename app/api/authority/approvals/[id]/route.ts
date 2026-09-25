// Marketr — GET /api/authority/approvals/:id (viewer+)
// Single approval with its exact binding payload and approver list.

import { authorityGuard } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityApprovals } from "@/lib/authority/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ approval: null, tablesReady: false });
  }
  const { id } = await params;
  const a = await authorityApprovals.get(id, gate.workspaceId);
  if (!a) return Response.json({ error: "Approval not found in workspace." }, { status: 404 });
  return Response.json({
    approval: {
      id: a.id,
      type: a.type,
      status: a.status,
      bindingJson: a.bindingJson,
      bindingHash: a.bindingHash,
      approvers: a.approvers,
      twoPersonRequired: a.twoPersonRequired,
      decidedAt: a.decidedAt,
      executedAt: a.executedAt,
      revokedAt: a.revokedAt,
      revokedBy: a.revokedBy,
      createdBy: a.createdBy,
      createdAt: a.createdAt,
    },
  });
}
