// ShapesOS — Phase 12 (people): POST /api/ops/pay-runs/[id]/[action]. ADMIN.
//   compute                  (re)compute payslips for a draft / computed run
//   approve { approvalId? }  Tier 3: without an approvalId → 202 + a pending
//                            OPS_PAYROLL_APPROVE approval (a person approves it
//                            in the Actions queue or inline); with it → the
//                            approval is verified + consumed and the run frozen
//   post { approvalId? }     Tier 3: OPS_PAYROLL_POST the same way; executing
//                            writes ONE balanced journal entry (idempotent)
//   cancel                   draft / computed / approved → cancelled
// Phase 14 (connectors), with Gusto connected (lib/bizsync/gusto/payroll.ts):
//   send_to_gusto { approvalId? }  Tier 3: without an approvalId → 202 + a
//                            pending OPS_PAYROLL_SEND_PROVIDER approval bound to
//                            the run's figures; with it → verified + consumed
//                            and the hours are written into Gusto's open
//                            payroll for the period (idempotent per figures)
//   sync_gusto               after the person submitted it in Gusto: Gusto's
//                            taxes and net pay → the payslips (computed run);
//                            paid + posted → Net pay payable cleared once
// Never moves money itself: Gusto pays people once a person submits there.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard, optString, readJsonBody } from "@/lib/ops/finance/http";
import { approvePayRun, cancelPayRun, computePayRun, postPayRun } from "@/lib/ops/payroll/runs";
import { ConnectorApiError } from "@/lib/connectors/m21/live/http";

/** Phase 14: the workspace's live Gusto connection as API auth, or a 409. */
async function gustoAuthFor(workspaceId: string, userId: string) {
  const { liveConnection } = await import("@/lib/bizsync/connection");
  const { gustoAuthFrom } = await import("@/lib/connectors/m21/native/gusto");
  const live = await liveConnection(workspaceId, "gusto", userId);
  const auth = gustoAuthFrom(live?.credential ?? null, { refreshCredential: live?.refreshCredential });
  return auth ?? Response.json({ error: "Gusto is not connected. Connect it in Settings → Connectors.", code: "not_connected" }, { status: 409 });
}

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
      case "send_to_gusto":
      case "sync_gusto": {
        const auth = await gustoAuthFor(ws, actor.userId);
        if (auth instanceof Response) return auth;
        const g = await import("@/lib/bizsync/gusto/payroll");
        if (action === "send_to_gusto") {
          const r = await g.withGustoRun(ws, "send_payroll", actor.userId, () => g.sendPayRunToGusto(ws, id, auth, actor, { kind: "ops_approval", approvalId }));
          if (r.outcome === "approval_required") return Response.json({ approval_required: true, approval: r.approval }, { status: 202 });
          return Response.json({ gusto: r });
        }
        const r = await g.withGustoRun(ws, "sync_payroll_results", actor.userId, () => g.syncPayRunFromGusto(ws, id, auth, actor));
        return Response.json({ gusto: r });
      }
      case "cancel": {
        const run = await withWorkspaceScope(ws, (tx) => cancelPayRun(tx, actor, id));
        return Response.json({ run });
      }
      default:
        return Response.json({ error: "Unknown action — use compute, approve, post, cancel, send_to_gusto or sync_gusto" }, { status: 404 });
    }
  } catch (err) {
    if (err instanceof ConnectorApiError) return Response.json({ error: err.message, code: err.code }, { status: err.code === "auth_rejected" || err.code === "forbidden" ? 409 : 502 });
    return financeError(err);
  }
}
