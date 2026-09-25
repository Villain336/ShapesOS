// Marketr — GET /api/media/approvals/:id
// The binding review screen's data: approval + hash-chained event log.

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
    const { approvals } = mediaStores();
    const approval = await approvals.get(id, gate.workspaceId);
    if (!approval) return Response.json({ error: "Approval not found" }, { status: 404 });
    const events = await approvals.getEvents(id, gate.workspaceId, 500);
    return Response.json({ approval, events });
  } catch (err) {
    return safetyError(err);
  }
}
