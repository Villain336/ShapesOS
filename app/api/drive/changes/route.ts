// ShapesOS — Phase 21B (WS=drive): the change journal. The one feed sync clients,
// apps and Spotlight indexing consume (contract: lib/drive/SYNC-CONTRACT.md).
// GET /api/drive/changes?workspaceId=&cursor=&limit=   (viewer+)
//   -> { changes: [{seq, cursor, type, entity, entityId, path, prevPath, version, actorUserId, at}],
//        cursor, head, hasMore }
// Events come in strict sequence order (commit order); pass the returned `cursor` back to
// continue. 400 for a cursor we did not issue, 410 when it is older than the journal keeps
// (do a full listing, then follow from `head`). A person's private home appears only in
// that person's own feed.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess } from "@/lib/route-utils";
import { CursorExpiredError, listChanges } from "@/lib/drive/changes";
import { CursorError } from "@/lib/drive/journal";
import { filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const qs = req.nextUrl.searchParams;
  const access = await requireWorkspaceAccess(user.id, qs.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  try {
    const page = await listChanges({ workspaceId: access.workspaceId, viewerUserId: user.id, cursor: qs.get("cursor"), limit: Number(qs.get("limit")) || undefined });
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof CursorError) return Response.json({ error: err.message, code: "bad_cursor" }, { status: 400 });
    if (err instanceof CursorExpiredError) return Response.json({ error: err.message, code: "cursor_expired" }, { status: 410 });
    return filesErrorResponse(err, "drive changes");
  }
}
