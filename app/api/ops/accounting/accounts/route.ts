// ShapesOS — Phase 10 (finance): GET /api/ops/accounting/accounts.
// The workspace's chart of accounts (seeded with the standard small-business
// chart on first use). Viewer+. Create / rename / deactivate go through the
// generic /api/ops/accounts entity route (editor+).

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listAccounts } from "@/lib/ops/accounting";
import { financeError, financeGuard } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const accounts = await withWorkspaceScope(actor.workspaceId, (tx) => listAccounts(tx, actor.workspaceId));
    return Response.json({ accounts });
  } catch (err) {
    return financeError(err);
  }
}
