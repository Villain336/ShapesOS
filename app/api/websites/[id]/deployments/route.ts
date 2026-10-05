// Marketr — list a site's deployments (milestone 9; Phase 9 adds rollback state).
// GET /api/websites/[id]/deployments?projectId=…
//   → { deployments: [{ id, target, targetLabel, url, deploymentId, status, mock, createdAt,
//        current, canRollBack, rollbackReason, rollbackOf, rollback: { approvalId, status } | null }] }
// `rollback` is an open (pending / approved) rollback approval for that row
// (lib/deploy/rollback.ts); the button runs it once it is approved.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { ownedSite } from "@/lib/connectors/source";
import { deployTargetSlug, hostingKindLabel } from "@/lib/deploy";
import { openRollbackApprovals, rollbackEligibility } from "@/lib/deploy/rollback";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId") ?? "";
  const site = await ownedSite(user.id, projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const [rows, project] = await Promise.all([
    prisma.deployment.findMany({ where: { siteId: site.id }, orderBy: { createdAt: "desc" } }),
    prisma.project.findUnique({ where: { id: site.projectId }, select: { workspaceId: true } }),
  ]);
  const eligibility = rollbackEligibility(rows);
  const open = project
    ? await openRollbackApprovals(project.workspaceId, site.id).catch(() => new Map<string, { approvalId: string; status: string }>())
    : new Map<string, { approvalId: string; status: string }>();

  return Response.json({
    deployments: rows.map((d) => {
      const e = eligibility.get(d.id);
      return {
        id: d.id,
        target: deployTargetSlug(d.target),
        targetLabel: hostingKindLabel(d.target),
        url: d.url,
        deploymentId: d.deploymentId,
        status: d.status,
        mock: d.mock,
        createdAt: d.createdAt.toISOString(),
        current: e?.current ?? false,
        canRollBack: e?.canRollBack ?? false,
        rollbackReason: e?.reason ?? null,
        rollbackOf: d.rollbackOf,
        rollback: open.get(d.id) ?? null,
      };
    }),
  });
}
