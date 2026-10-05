// ShapesOS — Phase 13 (twincore): GET /api/twin/sites/[id]/state
//
// The site's snapshot (lib/twin/state.ts siteSnapshot): every layout object
// with its state derived from the bound record, KPIs, shipments and agent
// markers. Operator role or above (workspace editor+); a site of another
// workspace is 404. Never cached — it is live operational state. The read
// rate-limit tier applies via proxy.ts (GET).

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { siteSnapshot, TwinNotFoundError } from "@/lib/twin/state";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const snapshot = await siteSnapshot(workspace.id, id);
    return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof TwinNotFoundError) return Response.json({ error: err.message }, { status: 404, headers: { "cache-control": "no-store" } });
    return errorResponse(err);
  }
}
