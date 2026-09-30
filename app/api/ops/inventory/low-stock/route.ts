// Marketr — Phase 17 slice 3: GET /api/ops/inventory/low-stock.
// Computed low-stock alert list: products that track inventory and are
// at/below their lowStockThreshold. Read-only — viewer+.
// (Like the invoice overdue sweep, this is computed on read; no cron yet.)

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { lowStockProducts } from "@/lib/ops/inventory";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  try {
    const products = await withWorkspaceScope(workspace.id, (tx) =>
      lowStockProducts(tx, { workspaceId: workspace.id, userId: user.id }),
    );
    return Response.json({ products });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
