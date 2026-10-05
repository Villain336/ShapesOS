// ShapesOS — Phase 12 (mfgpos): the CAD side of manufacturing.
//   GET  → { parts: [{ id, name, sku, opsProductId }], bomVersions: [{ id, label, lineCount }] }
//        (viewer+): what a routing can point at, and which CAD parts are
//        already linked to an Ops product.
//   POST { cadPartId, productId | null } (editor+): link a CAD part to the Ops
//        product it is stocked as (null unlinks). An MO consumes a BOM line's
//        components through this link; unlinked lines are costed but never
//        moved. The CAD BOM stays the only BOM.

import { z } from "zod";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard, readJsonBody } from "@/lib/ops/finance/http";
import { cadCatalog, linkCadPart } from "@/lib/ops/mfg/service";

export const dynamic = "force-dynamic";

const Body = z.object({ cadPartId: z.string().min(1).max(64), productId: z.string().min(1).max(64).nullable() });

export async function GET() {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    return Response.json(await withWorkspaceScope(actor.workspaceId, (tx) => cadCatalog(tx, actor.workspaceId)));
  } catch (err) {
    return financeError(err);
  }
}

export async function POST(req: Request) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const raw = await readJsonBody(req);
    const parsed = Body.safeParse(raw);
    if (!raw || !parsed.success) return Response.json({ error: parsed.error?.issues[0]?.message ?? "Invalid link" }, { status: 400 });
    const part = await withWorkspaceScope(actor.workspaceId, (tx) => linkCadPart(tx, actor, parsed.data.cadPartId, parsed.data.productId));
    return Response.json({ part });
  } catch (err) {
    return financeError(err);
  }
}
