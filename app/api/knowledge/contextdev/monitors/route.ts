// Marketr — Wave 2 context.dev slice 4: monitors API.
// GET /api/knowledge/contextdev/monitors — list monitors.
// POST — register a monitor (name, url, cadence, optional source link).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  registerMonitor,
  listMonitors,
  MonitorError,
  MONITOR_CADENCES,
} from "@/lib/knowledge/contextdev/monitor";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const monitors = await listMonitors(workspace.id);
  return NextResponse.json({ monitors });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { name?: string; url?: string; cadence?: string; sourceId?: string; autoResearch?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.name?.trim() || !body.url?.trim()) {
    return NextResponse.json({ error: "name and url are required" }, { status: 400 });
  }
  if (body.cadence && !MONITOR_CADENCES.includes(body.cadence as never)) {
    return NextResponse.json(
      { error: `cadence must be one of: ${MONITOR_CADENCES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const monitor = await registerMonitor(workspace.id, {
      name: body.name,
      url: body.url,
      cadence: (body.cadence as "hourly" | "daily" | "weekly" | undefined) ?? "daily",
      sourceId: body.sourceId,
      autoResearch: body.autoResearch,
    });
    return NextResponse.json({ monitor }, { status: 201 });
  } catch (err) {
    if (err instanceof MonitorError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
