// ShapesOS — Phase 13 (twincore): GET /api/twin/sites/[id]/state
//
// The site's snapshot (lib/twin/state.ts siteSnapshot): every layout object
// with its state derived from the bound record, KPIs, shipments and agent
// markers. Phase 14 (approvals): any workspace member (viewer+) for a
// PUBLISHED site; drafts stay editor+ (operator role) — a draft is 404 for a
// viewer, like a site of another workspace. Never cached — it is live
// operational state. The read rate-limit tier applies via proxy.ts (GET).
//
// Phase 17 (latency): the change signal (lib/twin/signal.ts). Every answer
// carries ETag "twin-<version>"; a request whose If-None-Match holds the
// current version gets 304 WITHOUT the snapshot being built. ?signal=1
// answers just { version } — the polling client asks that first and fetches
// the snapshot only when the version moved. The same access rules apply (a
// draft is 404 for a viewer, whichever form is asked).

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { canViewSite, siteSnapshotFor, TwinNotFoundError } from "@/lib/twin/state";
import { etagMatches, siteSignal, twinEtag } from "@/lib/twin/signal";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    const signal = await siteSignal(workspace.id, id);
    if (!signal.status || !canViewSite(signal.status, canEdit)) throw new TwinNotFoundError(id);
    const headers = { "cache-control": "no-store", etag: twinEtag(signal.version) };
    if (req.nextUrl.searchParams.get("signal") === "1") return Response.json({ version: signal.version }, { headers });
    if (etagMatches(req.headers.get("if-none-match"), signal.version)) return new Response(null, { status: 304, headers });
    const snapshot = await siteSnapshotFor(workspace.id, id, canEdit);
    return Response.json(snapshot, { headers });
  } catch (err) {
    if (err instanceof TwinNotFoundError) return Response.json({ error: err.message }, { status: 404, headers: { "cache-control": "no-store" } });
    return errorResponse(err);
  }
}
