// ShapesOS — Phase 10 (finance): POST /api/ops/quotes/[id]/convert
//   { target: "invoice" | "order" } → a DRAFT invoice or order with the
// quote's lines, linked both ways (idempotent per quote + target; a sent
// quote becomes accepted). Drafts are free writes; sending the invoice still
// asks. Editor+.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { convertQuote } from "@/lib/ops/finance/quotes";
import { financeError, financeGuard, readJsonBody } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const body = await readJsonBody(req);
    const target = body?.target;
    if (target !== "invoice" && target !== "order") {
      return Response.json({ error: 'target must be "invoice" or "order"' }, { status: 400 });
    }
    const r = await withWorkspaceScope(actor.workspaceId, (tx) => convertQuote(tx, actor, id, target));
    return Response.json({ target: r.target, id: r.id, created: r.created, quoteStatus: r.quote.status }, { status: r.created ? 201 : 200 });
  } catch (err) {
    return financeError(err);
  }
}
