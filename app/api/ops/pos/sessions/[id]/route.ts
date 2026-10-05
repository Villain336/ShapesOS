// ShapesOS — Phase 12 (mfgpos): GET /api/ops/pos/sessions/[id] — a till
// session with its live totals (sales, tax, cash, card) and the expected
// cash in the drawer. Viewer+, workspace-scoped (404 otherwise).
// Opening, counting and closing go through /api/ops/pos-sessions.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard } from "@/lib/ops/finance/http";
import { sessionSummary } from "@/lib/ops/pos/service";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const session = await withWorkspaceScope(actor.workspaceId, (tx) => sessionSummary(tx, actor.workspaceId, id));
    return Response.json({ session });
  } catch (err) {
    return financeError(err);
  }
}
