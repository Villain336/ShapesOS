// ShapesOS — Phase 13 (twincore): GET /api/twin/sites/[id]/state
//
// The site's snapshot (lib/twin/state.ts siteSnapshot): every layout object
// with its state derived from the bound record, KPIs, shipments and agent
// markers. Phase 14 (approvals): any workspace member (viewer+) for a
// PUBLISHED site; drafts stay editor+ (operator role) — a draft is 404 for a
// viewer, like a site of another workspace. Never cached — it is live
// operational state. The read rate-limit tier applies via proxy.ts (GET).

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { siteSnapshotFor, TwinNotFoundError } from "@/lib/twin/state";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) {
    return Response.json({ error: "Forbidden: workspace members only" }, { status: 403 });
  }
  // Drafts are editor-only (the snapshot path refuses a draft to a viewer).
  const canEdit = Boolean(await requireWorkspaceRole(user.id, workspace.id, "editor"));
  const { id } = await params;
  try {
    const snapshot = await siteSnapshotFor(workspace.id, id, canEdit);
    return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof TwinNotFoundError) return Response.json({ error: err.message }, { status: 404, headers: { "cache-control": "no-store" } });
    return errorResponse(err);
  }
}
