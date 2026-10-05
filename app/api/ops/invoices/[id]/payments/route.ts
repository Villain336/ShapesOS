// ShapesOS — Phase 10 (finance): /api/ops/invoices/[id]/payments.
//   GET  → { invoice, payments, creditNotes, balanceDueCents } (viewer+)
//   POST { amountCents, provider?, providerRef?, note?, approvalId? } (editor+)
//        records a (partial) payment: a gated payments create
//        (OPS_PAYMENT_RECORD_CHARGE) — 202 approval_required first, then
//        with the approved approvalId it applies + posts (Dr Cash / Cr AR).

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { opsCreate, opsEntityDef } from "@/lib/ops/doctype";
import { invoiceAccount } from "@/lib/ops/finance/invoicing";
import { financeError, financeGuard, optString, readJsonBody } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    return Response.json(await withWorkspaceScope(actor.workspaceId, (tx) => invoiceAccount(tx, actor.workspaceId, id)));
  } catch (err) {
    return financeError(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const body = await readJsonBody(req);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const payment: Record<string, unknown> = {
      invoiceId: id,
      kind: "charge",
      status: "succeeded",
      amountCents: body.amountCents,
      provider: optString(body.provider) ?? "manual",
      ...(optString(body.providerRef) ? { providerRef: optString(body.providerRef) } : {}),
      ...(optString(body.note) ? { note: optString(body.note) } : {}),
      ...(optString(body.approvalId) ? { approvalId: optString(body.approvalId) } : {}),
    };
    const result = await withWorkspaceScope(actor.workspaceId, (tx) => opsCreate(tx, opsEntityDef("payments"), actor, payment));
    if (result.outcome === "approval_required") {
      return Response.json({ approval_required: true, approval: result.approval }, { status: 202 });
    }
    return Response.json({ payment: result.row }, { status: 201 });
  } catch (err) {
    return financeError(err);
  }
}
