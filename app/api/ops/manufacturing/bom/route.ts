// ShapesOS — Phase 12 (mfgpos): GET /api/ops/manufacturing/bom?productId=…
// The product's bill of materials, DERIVED from the CAD BOM revision its
// active routing points at (CadBomLine → CadPart.opsProductId) — there is
// no second BOM model. Viewer+, workspace-scoped.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard } from "@/lib/ops/finance/http";
import { productBom } from "@/lib/ops/mfg/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const productId = new URL(req.url).searchParams.get("productId") ?? "";
    if (!productId || productId.length > 64) return Response.json({ error: "productId is required" }, { status: 400 });
    const bom = await withWorkspaceScope(actor.workspaceId, async (tx) => {
      const p = await tx.opsProduct.findFirst({ where: { id: productId, workspaceId: actor.workspaceId }, select: { id: true } });
      return p ? productBom(tx, actor.workspaceId, productId) : null;
    });
    if (!bom) return Response.json({ error: `products "${productId}" not found in workspace` }, { status: 404 });
    return Response.json({ bom });
  } catch (err) {
    return financeError(err);
  }
}
