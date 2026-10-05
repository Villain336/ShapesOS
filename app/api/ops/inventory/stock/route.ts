// ShapesOS Phase 10 (ops-core): GET /api/ops/inventory/stock
//   ?warehouseId= &locationId= &productId=
// Per-location, per-variant stock ("quants") DERIVED from the append-only
// inventory ledger (lib/ops/stock.ts stockByLocation). Viewer+; RLS-scoped.

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { stockByLocation } from "@/lib/ops/stock";
import { OpsError } from "@/lib/ops/doctype";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const q = req.nextUrl.searchParams;
    const pick = (k: string) => {
      const v = q.get(k);
      return v && v.length <= 64 ? v : undefined;
    };
    const actor = { workspaceId: workspace.id, userId: user.id };
    const rows = await withWorkspaceScope(workspace.id, (tx) =>
      stockByLocation(tx, actor, { warehouseId: pick("warehouseId"), locationId: pick("locationId"), productId: pick("productId") }),
    );
    return Response.json({ rows });
  } catch (err) {
    if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
    return errorResponse(err);
  }
}
