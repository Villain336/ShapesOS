// ShapesOS — Phase 10 (finance): /api/ops/purchase-orders/[id]/receipts.
//   GET  → the PO's receipts (newest first). Viewer+.
//   POST { lines: [{ index, qty }], note? } → records a (partial) delivery:
//        one append-only receipt + a restock inventory txn per received
//        product line, in one transaction under a row lock on the PO; the PO
//        moves to partially_received or received. Free logged write
//        (fulfilment), like the original receive. Editor+.

import { z } from "zod";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { receivePurchaseOrder } from "@/lib/ops/finance/purchasing";
import { financeError, financeGuard, readJsonBody } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  lines: z.array(z.object({ index: z.number().int().min(0).max(199), qty: z.number().int().min(1).max(100_000) })).min(1).max(200),
  note: z.string().max(2000).optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const receipts = await withWorkspaceScope(actor.workspaceId, (tx) =>
      tx.opsPurchaseReceipt.findMany({ where: { workspaceId: actor.workspaceId, purchaseOrderId: id }, orderBy: { receivedAt: "desc" } }),
    );
    return Response.json({ receipts });
  } catch (err) {
    return financeError(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const parsed = Body.safeParse(await readJsonBody(req));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid receipt" }, { status: 400 });
    const r = await withWorkspaceScope(actor.workspaceId, (tx) => receivePurchaseOrder(tx, actor, id, parsed.data.lines, parsed.data.note));
    return Response.json(r, { status: 201 });
  } catch (err) {
    return financeError(err);
  }
}
