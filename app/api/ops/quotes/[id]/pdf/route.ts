// ShapesOS — Phase 10 (finance): GET /api/ops/quotes/[id]/pdf — the quote
// as a PDF (lib/pdf engine). Viewer+, workspace-scoped.

import { renderQuotePdf } from "@/lib/ops/finance/quotes";
import { financeError, financeGuard } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const { pdf, filename } = await renderQuotePdf(actor.workspaceId, id);
    return new Response(new Uint8Array(pdf), {
      headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${filename}"`, "cache-control": "private, no-store" },
    });
  } catch (err) {
    return financeError(err);
  }
}
