// ShapesOS — Phase 9 (sites): one-click rollback to an earlier deployment.
// POST /api/websites/[id]/deployments/[deploymentId]/rollback { projectId, approvalId? }
//   no approvalId → 202 { status: "pending_approval", approval } — a Tier-2
//                   approval lands in Actions / the "needs you" inbox
//   approvalId    → runs the provider rollback once that approval is approved
//                   → { ok, url, status, mock, recordId }
// [deploymentId] is our Deployment row id. Editor+; the approval gate
// (lib/deploy/rollback.ts) decides whether it may run.

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import { prisma } from "@/lib/prisma";
import { ownedSite } from "@/lib/connectors/source";
import { errorResponse } from "@/lib/api/errors";
import { hostingConnectorFor, hostingKindLabel } from "@/lib/deploy";
import {
  RollbackError,
  approverOf,
  executeRollback,
  phase14RollbackPort,
  requestRollback,
  rollbackBinding,
  rollbackEligibility,
} from "@/lib/deploy/rollback";

export const dynamic = "force-dynamic";

function fail(err: unknown, req: NextRequest) {
  if (err instanceof RollbackError) return Response.json({ error: err.message, code: err.code }, { status: err.status });
  return errorResponse(err, "deploy rollback", req);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; deploymentId: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id, deploymentId } = await params;
  const body = await readJsonBody<{ projectId?: string; approvalId?: string }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "editor"))) return forbidden();

  const rows = await prisma.deployment.findMany({ where: { siteId: site.id }, orderBy: { createdAt: "desc" } });
  const dep = rows.find((r) => r.id === deploymentId);
  if (!dep) return Response.json({ error: "Deployment not found" }, { status: 404 });
  const verdict = rollbackEligibility(rows).get(dep.id);
  if (!verdict?.canRollBack) {
    return Response.json({ error: verdict?.reason ?? "This deployment can't be restored.", code: "not_restorable" }, { status: 409 });
  }
  const conn = dep.connectionId
    ? await prisma.hostingConnection.findFirst({ where: { id: dep.connectionId, projectId: site.projectId } })
    : null;
  if (!conn) return Response.json({ error: "Its hosting connection was removed." }, { status: 409 });
  const project = await prisma.project.findUnique({ where: { id: site.projectId }, select: { workspaceId: true } });
  if (!project) return Response.json({ error: "Site not found" }, { status: 404 });

  const binding = rollbackBinding(dep);
  const label = hostingKindLabel(dep.target);

  try {
    if (!body?.approvalId) {
      const when = dep.createdAt.toISOString().slice(0, 16).replace("T", " ");
      const approval = await requestRollback(phase14RollbackPort, {
        workspaceId: project.workspaceId,
        binding,
        actor: user.id,
        summary: `Roll back ${site.name} on ${label} to the deployment from ${when} UTC${dep.mock ? " (demo)" : ""}`,
      });
      return Response.json({ status: "pending_approval", approval }, { status: 202 });
    }

    const { result, approval } = await executeRollback(phase14RollbackPort, {
      workspaceId: project.workspaceId,
      binding,
      approvalId: body.approvalId,
      actor: user.id,
      target: hostingConnectorFor(conn),
      place: { project: dep.providerProject, projectName: site.name },
    });

    const record = await prisma.deployment.create({
      data: {
        siteId: site.id,
        projectId: site.projectId,
        connectionId: conn.id,
        target: dep.target,
        url: result.url ?? dep.url,
        deploymentId: dep.deploymentId,
        status: result.status,
        mock: result.mock === true,
        providerProject: dep.providerProject,
        rollbackOf: dep.id,
      },
    });
    await prisma.fileChangeLog.create({
      data: {
        projectId: site.projectId,
        siteId: site.id,
        filePath: "/",
        actor: "user",
        action: "deploy",
        summary: `Rolled back ${label} to the deployment from ${dep.createdAt.toISOString().slice(0, 10)}${result.mock ? " (mock)" : ""}`.slice(0, 280),
        approvedBy: approverOf(approval.auditTrail) ?? user.id,
      },
    });
    return Response.json({
      ok: true,
      url: result.url ?? dep.url,
      status: result.status,
      mock: result.mock === true,
      recordId: record.id,
    });
  } catch (err) {
    return fail(err, req);
  }
}
