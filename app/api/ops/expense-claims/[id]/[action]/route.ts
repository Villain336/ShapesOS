// ShapesOS — Phase 10 (finance): POST /api/ops/expense-claims/[id]/[action].
//   submit                  claimant only: numbers the claim and proposes an
//                           OPS_EXPENSE_APPROVE approval (202 + approval)
//   approve { approvalId }  executes the approved approval: posts Dr Expense /
//                           Cr Reimbursements payable. Separation of duties is
//                           enforced when the approval is decided (Phase 14).
//   reject { reason }       a reviewer's decision (not the claimant)
//   reimburse { approvalId? } gated OPS_EXPENSE_REIMBURSE: 202 first, then
//                           Dr Reimbursements payable / Cr Cash
// Editor+.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  approveExpenseClaim,
  getExpenseClaim,
  reimburseExpenseClaim,
  rejectExpenseClaim,
  submitExpenseClaim,
} from "@/lib/ops/finance/expenses";
import { financeError, financeGuard, optString, readJsonBody } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id, action } = await params;
    const body = (await readJsonBody(req)) ?? {};
    const approvalId = optString(body.approvalId);
    const ws = actor.workspaceId;
    switch (action) {
      case "submit": {
        const r = await withWorkspaceScope(ws, (tx) => submitExpenseClaim(tx, actor, id));
        return Response.json({ approval_required: true, approval: r.approval, number: r.number }, { status: 202 });
      }
      case "approve": {
        if (!approvalId) return Response.json({ error: "approvalId is required (approve it in the Actions queue first)" }, { status: 400 });
        const r = await withWorkspaceScope(ws, (tx) => approveExpenseClaim(tx, actor, id, approvalId));
        return Response.json(r);
      }
      case "reject": {
        const r = await withWorkspaceScope(ws, async (tx) => {
          const c = await getExpenseClaim(tx, ws, id);
          if (c.claimantId === actor.userId) return null;
          return rejectExpenseClaim(tx, actor, id, optString(body.reason) ?? "");
        });
        if (!r) return Response.json({ error: "You can't decide on your own claim — another reviewer must" }, { status: 403 });
        return Response.json(r);
      }
      case "reimburse": {
        const r = await withWorkspaceScope(ws, (tx) => reimburseExpenseClaim(tx, actor, id, approvalId));
        if (r.outcome === "approval_required") return Response.json({ approval_required: true, approval: r.approval }, { status: 202 });
        return Response.json(r);
      }
      default:
        return Response.json({ error: "Unknown action — use submit, approve, reject or reimburse" }, { status: 404 });
    }
  } catch (err) {
    return financeError(err);
  }
}
