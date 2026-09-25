// Marketr — POST /api/authority/approvals/:id/reject (editor+)
// A human rejects the pending approval. Rejected approvals can never be executed.

import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityApprovals } from "@/lib/authority/db";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const { id } = await params;
  try {
    const approval = await authorityApprovals.reject(id, gate.workspaceId, gate.userId);
    return Response.json({
      approval: { id: approval.id, type: approval.type, status: approval.status },
    });
  } catch (err) {
    return safetyError(err);
  }
}
