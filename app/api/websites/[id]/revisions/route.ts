// ShapesOS — Phase 9 (sites): a site's revisions (agent drafts + backups).
// GET /api/websites/[id]/revisions?projectId=…
//   → { revisions: [{ id, number, status, source, runId, summary, fileCount, bytes,
//        hasPatch, patchTruncated, createdAt, appliedAt, backupId }] }
// Files and the diff are served per revision (./[revisionId]).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { ownedSite } from "@/lib/connectors/source";
import { listSiteRevisions } from "@/lib/sites/revisions";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const site = await ownedSite(user.id, req.nextUrl.searchParams.get("projectId") ?? "", id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "viewer"))) return forbidden();
  const project = await prisma.project.findUnique({ where: { id: site.projectId }, select: { workspaceId: true } });
  if (!project) return Response.json({ error: "Site not found" }, { status: 404 });

  const rows = await listSiteRevisions(project.workspaceId, site.id);
  return Response.json({
    revisions: rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      source: r.source,
      runId: r.runId,
      summary: r.summary,
      fileCount: r.fileCount,
      bytes: r.bytes,
      hasPatch: r.hasPatch,
      patchTruncated: r.patchTruncated,
      createdAt: r.createdAt.toISOString(),
      appliedAt: r.appliedAt?.toISOString() ?? null,
      backupId: r.backupId,
    })),
  });
}
