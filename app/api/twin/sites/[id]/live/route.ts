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
// editor+ (403), the site in the caller's workspace (404).

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { siteSnapshot, TwinNotFoundError } from "@/lib/twin/state";
import { twinLiveStream, TWIN_SSE_HEADERS } from "@/lib/twin/live";
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
  let first;
  try {
    first = await siteSnapshot(workspace.id, id);
  } catch (err) {
    if (err instanceof TwinNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    return errorResponse(err);
  }
  const stream = twinLiveStream(first, {
    snapshot: () => siteSnapshot(workspace.id, id),
    stillAllowed: async () => Boolean(await requireWorkspaceRole(user.id, workspace.id, "editor")),
  });
  return new Response(stream, { headers: TWIN_SSE_HEADERS });
}
