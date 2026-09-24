// Marketr — R4: AI-drafted reply for one monitored review.
// POST /api/reviews/[id]/draft-response (editor+)
//   → { review, draftBody, approvalId, approvalStatus, mock }
// Approve the draft via /api/messaging/approvals (messaging-core). After a
// human posts the approved reply manually (GBP API approval pending), record
// it with recordManualPost() — see lib/reviews/responder.ts.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { draftReviewResponse, ResponderError } from "@/lib/reviews/responder";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  const { id } = await ctx.params;
  try {
    const res = await draftReviewResponse(workspace.id, id, { requestedBy: user.id });
    return Response.json(
      {
        reviewId: res.review.id,
        draftBody: res.draftBody,
        approvalId: res.approval.id,
        approvalStatus: res.approval.status,
        mock: res.mock,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof ResponderError) {
      const status = e.code === "not_found" ? 404 : e.code === "already_responded" ? 409 : 400;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    throw e;
  }
}
