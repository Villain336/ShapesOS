// ShapesOS — Phase 10 (finance): POST /api/ops/purchase-orders/[id]/bill —
// a DRAFT vendor bill from a sent PO (received quantities when anything was
// received, else the ordered quantities; idempotent: an existing open/draft
// bill for the PO is returned). Posting and paying it happen on the bill.
// Editor+.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { billFromPurchaseOrder } from "@/lib/ops/finance/purchasing";
import { financeError, financeGuard } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const r = await withWorkspaceScope(actor.workspaceId, (tx) => billFromPurchaseOrder(tx, actor, id));
    return Response.json(r, { status: r.created ? 201 : 200 });
  } catch (err) {
    return financeError(err);
  }
}
