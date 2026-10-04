// ShapesOS — Phase 12 (mfgpos): GET /api/ops/pos/orders/[id]/receipt — a
// till sale's receipt as a PDF, rendered by the existing lib/pdf engine
// (the finance document builder). Viewer+, workspace-scoped.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard } from "@/lib/ops/finance/http";
import { pdfFilename, renderFinancePdf } from "@/lib/ops/finance/pdf";
import { receiptDoc } from "@/lib/ops/pos/service";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const doc = await withWorkspaceScope(actor.workspaceId, (tx) => receiptDoc(tx, actor.workspaceId, id));
    const pdf = await renderFinancePdf(doc);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pdfFilename("Receipt", doc.number, id)}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    return financeError(err);
  }
}
