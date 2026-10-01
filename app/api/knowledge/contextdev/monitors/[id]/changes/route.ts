// Marketr — Wave 2 context.dev slice 4: monitor changes API.
// GET /api/knowledge/contextdev/monitors/[id]/changes — detected changes,
// newest first, with diff digests and any spawned research task.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { listMonitorChanges, MonitorError } from "@/lib/knowledge/contextdev/monitor";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  try {
    const changes = await listMonitorChanges(workspace.id, id);
    return NextResponse.json({ changes });
  } catch (err) {
    if (err instanceof MonitorError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
    }
    throw err;
  }
}
