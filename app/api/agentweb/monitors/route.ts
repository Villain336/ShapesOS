// ShapesOS — Phase 21A round 2 (WS=agentweb): page monitors that start workflows.
//   GET  /api/agentweb/monitors → { monitors[], workflows[], links[] } (any member)
//   POST /api/agentweb/monitors { op: link | unlink, monitorId, workflowId } (editor+, same-origin JSON)
// The monitors are Context.dev's (Settings → Connections); this only links one to a workflow.
// The workflow still has to be switched on by a person, and runs as the person who linked it.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { humanClickGuard } from "@/lib/agentweb/commerce/http";
import { linkMonitor, listMonitorLinks, MonitorLinkError, unlinkMonitor } from "@/lib/agentweb/research/monitors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await answerActor();
    const [monitors, workflows, links] = await Promise.all([
      prisma.monitor.findMany({ where: { workspaceId: workspace.id, status: { not: "archived" } }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, url: true, cadence: true, status: true, lastChangeAt: true, lastCheckedAt: true } }),
      prisma.workflow.findMany({ where: { project: { workspaceId: workspace.id } }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, enabled: true, status: true } }),
      listMonitorLinks(workspace.id),
    ]);
    return NextResponse.json({ monitors, workflows, links }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace, role } = await answerActor();
    const guard = await humanClickGuard(req, { requireChannel: false, subject: "A page monitor" });
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
    const op = guard.body.op;
    const monitorId = typeof guard.body.monitorId === "string" ? guard.body.monitorId : "";
    const workflowId = typeof guard.body.workflowId === "string" ? guard.body.workflowId : "";
    if (!monitorId || !workflowId) return NextResponse.json({ error: "Say which monitor and which workflow." }, { status: 400 });
    try {
      if (op === "link") return NextResponse.json({ link: await linkMonitor(workspace.id, user.id, role, monitorId, workflowId) });
      if (op === "unlink") return NextResponse.json({ ok: await unlinkMonitor(workspace.id, role, monitorId, workflowId) });
    } catch (e) {
      if (e instanceof MonitorLinkError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === "forbidden" ? 403 : e.code === "not_found" ? 404 : 409 });
      throw e;
    }
    return NextResponse.json({ error: "Unknown operation." }, { status: 400 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
