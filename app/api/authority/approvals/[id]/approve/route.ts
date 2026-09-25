// Marketr — POST /api/authority/approvals/:id/approve (editor+)
//
// A human approver's signature. The logged-in user is the approver identity —
// two distinct approvers are required for two-person approvals (e.g. the
// depth3_activation gate). The receipt binds approver + exact binding hash
// with the authority approval secret.

import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityApprovals } from "@/lib/authority/db";
import { approvalSecret } from "@/lib/authority/outreach/sequences";

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
    const approval = await authorityApprovals.approve(id, gate.workspaceId, gate.userId, approvalSecret());
    return Response.json({
      approval: {
        id: approval.id,
        type: approval.type,
        status: approval.status,
        approvers: approval.approvers,
        twoPersonRequired: approval.twoPersonRequired,
        decidedAt: approval.decidedAt,
      },
    });
  } catch (err) {
    return safetyError(err);
  }
}
