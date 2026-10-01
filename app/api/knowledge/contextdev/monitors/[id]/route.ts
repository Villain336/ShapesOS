// Marketr — Wave 2 context.dev slice 4: monitor status API.
// PATCH /api/knowledge/contextdev/monitors/[id] — pause / resume / archive.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { setMonitorStatus, MonitorError } from "@/lib/knowledge/contextdev/monitor";

const STATUSES = ["active", "paused", "archived"] as const;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!STATUSES.includes(body.status as never)) {
    return NextResponse.json(
      { error: `status must be one of: ${STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const monitor = await setMonitorStatus(workspace.id, id, body.status as (typeof STATUSES)[number]);
    return NextResponse.json({ monitor });
  } catch (err) {
    if (err instanceof MonitorError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
    }
    throw err;
  }
}
