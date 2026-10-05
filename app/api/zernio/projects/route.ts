// ShapesOS — Phase 15.4 (zernio): "Use in every project".
// POST /api/zernio/projects { workspaceId } (admin+) → { bound, projects }
// Binds the workspace's Zernio connection (connector key "zernio") to every
// project as a data source, so agents there can use the Zernio tools. Every
// write still goes through the approval gates (creating ads and raising
// budgets always ask). Idempotent.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auditEvent } from "@/lib/auditlog";
import { getZernioScope } from "@/lib/zernio/tenancy";
import { zernioErrorResponse, zernioGuard } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const g = await zernioGuard(req, "admin", raw);
  if (g instanceof Response) return g;
  try {
    await getZernioScope(g.workspaceId, { userId: g.userId });
    const connection = await prisma.connectorConnection.findFirst({
      where: { workspaceId: g.workspaceId, connectorKey: "zernio", status: "active" },
      select: { id: true },
    });
    if (!connection) return Response.json({ error: "No Zernio connection yet." }, { status: 409 });
    const projects = await prisma.project.findMany({ where: { workspaceId: g.workspaceId }, select: { id: true } });
    let bound = 0;
    for (const p of projects) {
      const r = await prisma.projectDataSource.upsert({
        where: { projectId_connectionId: { projectId: p.id, connectionId: connection.id } },
        create: { projectId: p.id, connectionId: connection.id, connectorKey: "zernio", createdBy: g.userId },
        update: {},
      });
      if (r) bound += 1;
    }
    await auditEvent({
      projectId: null,
      workspaceId: g.workspaceId,
      action: "zernio_projects_bound",
      summary: `Zernio: available to agents in ${bound} project${bound === 1 ? "" : "s"}`,
      actorUserId: g.userId,
    });
    return Response.json({ bound, projects: projects.length });
  } catch (e) {
    return zernioErrorResponse(e);
  }
}
