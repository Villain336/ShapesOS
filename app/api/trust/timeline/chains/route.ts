// ShapesOS — Phase 18.3 (WS=trust): verify the hash-chained audit trails.
//   GET /api/trust/timeline/chains → { chains: ChainResult[] }
// admin+; read-only; each trail verified with its own verify function where
// it has one (lib/audit-timeline/chains.server.ts).

import { errorResponse } from "@/lib/api/errors";
import { verifyChains } from "@/lib/audit-timeline/chains.server";
import { NO_STORE, trustGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await trustGuard("admin");
  if (ctx instanceof Response) return ctx;
  try {
    return Response.json({ chains: await verifyChains(ctx.workspaceId) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/trust/timeline/chains");
  }
}
