// Marketr — Wave 2 context.dev slice 4: manual monitor run API.
// POST /api/knowledge/contextdev/monitors/[id]/run — check now, outside the
// cadence (still budget-gated before the vendor).

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { runMonitorCheck, MonitorError } from "@/lib/knowledge/contextdev/monitor";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  try {
    const result = await runMonitorCheck(workspace.id, id);
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof MonitorError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
    }
    throw err;
  }
}
