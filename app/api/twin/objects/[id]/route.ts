// ShapesOS — Phase 13 (twincore): DELETE /api/twin/objects/[id]
//
// The layout editor removes ONE layout object (the generic /api/ops/[entity]
// route has no DELETE). Editor+ (operator role); the object must be in the
// caller's workspace (404 otherwise, RLS + explicit scope). Allowed on draft
// and published sites — layout edits move no money — but refused (409) for
// busy equipment and for a dock door whose dock has an active booking
// (lib/ops/twin/service.ts deleteObjectRow). Audited as an ops write. The
// bound record is never touched.

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OpsError } from "@/lib/ops/doctype";
import { deleteObjectRow } from "@/lib/ops/twin/service";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const row = await withWorkspaceScope(workspace.id, (tx) => deleteObjectRow(tx, { workspaceId: workspace.id, userId: user.id }, id));
    return Response.json({ deleted: true, id: row.id, siteId: row.siteId });
  } catch (err) {
    if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
    return errorResponse(err);
  }
}
