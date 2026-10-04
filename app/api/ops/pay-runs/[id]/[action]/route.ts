// ShapesOS — Phase 12 (people): POST /api/ops/pay-runs/[id]/[action]. ADMIN.
//   compute                  (re)compute payslips for a draft / computed run
//   approve { approvalId? }  Tier 3: without an approvalId → 202 + a pending
//                            OPS_PAYROLL_APPROVE approval (a person approves it
//                            in the Actions queue or inline); with it → the
//                            approval is verified + consumed and the run frozen
//   post { approvalId? }     Tier 3: OPS_PAYROLL_POST the same way; executing
//                            writes ONE balanced journal entry (idempotent)
//   cancel                   draft / computed / approved → cancelled
// Never moves money: net pay stays a liability until paid outside ShapesOS.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard, optString, readJsonBody } from "@/lib/ops/finance/http";
import { approvePayRun, cancelPayRun, computePayRun, postPayRun } from "@/lib/ops/payroll/runs";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const actor = await financeGuard("admin");
  if (actor instanceof Response) return actor;
  try {
    const { id, action } = await params;
    const body = (await readJsonBody(req)) ?? {};
    const approvalId = optString(body.approvalId);
    const ws = actor.workspaceId;
    switch (action) {
      case "compute": {
        const r = await withWorkspaceScope(ws, (tx) => computePayRun(tx, actor, id));
        return Response.json({ run: r.run, payslips: r.payslipCount, warnings: r.warnings });
      }
      case "approve":
      case "post": {
        const r = await withWorkspaceScope(ws, (tx) => (action === "approve" ? approvePayRun(tx, actor, id, approvalId) : postPayRun(tx, actor, id, approvalId)));
        if (r.outcome === "approval_required") return Response.json({ approval_required: true, approval: r.approval }, { status: 202 });
        return Response.json({ run: r.run, journalEntryId: r.journalEntryId ?? null });
      }
      case "cancel": {
        const run = await withWorkspaceScope(ws, (tx) => cancelPayRun(tx, actor, id));
        return Response.json({ run });
      }
      default:
        return Response.json({ error: "Unknown action — use compute, approve, post or cancel" }, { status: 404 });
    }
  } catch (err) {
    return financeError(err);
  }
}
