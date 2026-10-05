// ShapesOS — Phase 13 (twincore): GET /api/twin/sites/[id]/live
//
// text/event-stream of the site's live state (lib/twin/live.ts): a
// `snapshot` frame first (and after a layout change), then `patch` frames
// (RFC 6902) whenever the records behind the twin change, `: ping` every
// 15 s, and `end` at TWIN_LIVE_MAX_MS or when access/the site goes away.
// The server re-reads the database every TWIN_LIVE_POLL_MS — no in-memory
// bus, so it is safe across replicas; clients fall back to polling
// /api/twin/sites/[id]/state.
//
// Access (fail-closed, re-checked on every loop): signed in (401), workspace
// member (403), the site in the caller's workspace (404). Phase 14
// (approvals): every member gets live updates of a PUBLISHED site; drafts
// stay editor+. stillAllowed re-checks role AND status each tick, so a site
// moving back to draft ends a viewer's stream (access-revoked).

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { siteSnapshotFor, twinLiveAccess, TwinNotFoundError } from "@/lib/twin/state";
import { twinLiveStream, TWIN_SSE_HEADERS } from "@/lib/twin/live";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) {
    return Response.json({ error: "Forbidden: workspace members only" }, { status: 403 });
  }
  const isEditor = async () => Boolean(await requireWorkspaceRole(user.id, workspace.id, "editor"));
  const { id } = await params;
  let first;
  try {
    first = await siteSnapshotFor(workspace.id, id, await isEditor());
  } catch (err) {
    if (err instanceof TwinNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    return errorResponse(err);
  }
  // Re-checked every loop: still a member, and (unless an editor) the site is still published.
  const stream = twinLiveStream(
    first,
    twinLiveAccess({
      workspaceId: workspace.id,
      siteId: id,
      isMember: async () => Boolean(await requireWorkspaceRole(user.id, workspace.id, "viewer")),
      isEditor,
    }),
  );
  return new Response(stream, { headers: TWIN_SSE_HEADERS });
}
