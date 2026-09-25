// Marketr — GET /api/media/pools/:id — pool detail + encumbrance ledger.

import type { NextRequest } from "next/server";
import { mediaGuard, safetyError } from "../../_lib";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  try {
    const { id } = await params;
    const { pools } = mediaStores();
    const pool = await pools.get(id, gate.workspaceId);
    if (!pool) return Response.json({ error: "Pool not found" }, { status: 404 });
    const transactions = await pools.listTxs(id, gate.workspaceId, 200);
    return Response.json({ pool, transactions });
  } catch (err) {
    return safetyError(err);
  }
}
