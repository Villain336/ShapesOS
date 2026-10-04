// ShapesOS — Phase 9 (sites): one site revision.
// GET  /api/websites/[id]/revisions/[revisionId]?projectId=…
//   → { revision: { …summary, patch, paths } }
// POST /api/websites/[id]/revisions/[revisionId] { projectId, action: "apply" | "discard", force? }
//   apply   → the working copy becomes the revision's files; the current files
//             are saved first as a backup revision (applying it = revert).
//             409 code "site_changed" when the site moved on since the agent
//             checked it out — resend with force: true to apply anyway.
//   discard → a draft is marked discarded.
// Applying is the human approval of an agent draft (editor+); it never
// deploys or publishes — those stay their own gated actions.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { readJsonBody } from "@/lib/sitefiles/api";
import { prisma } from "@/lib/prisma";
import { ownedSite } from "@/lib/connectors/source";
import { getSiteRevision } from "@/lib/sites/revisions";
import { SiteRevisionError, applySiteRevision, discardSiteRevision } from "@/lib/sites/apply";

export const dynamic = "force-dynamic";

async function workspaceOf(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  return p?.workspaceId ?? null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id, revisionId } = await params;
  const site = await ownedSite(user.id, req.nextUrl.searchParams.get("projectId") ?? "", id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "viewer"))) return forbidden();
  const ws = await workspaceOf(site.projectId);
  const rev = ws ? await getSiteRevision(ws, site.id, revisionId) : null;
  if (!rev) return Response.json({ error: "Revision not found" }, { status: 404 });
  const { files, baseFingerprint: _base, ...rest } = rev;
  return Response.json({
    revision: {
      ...rest,
      createdAt: rev.createdAt.toISOString(),
      appliedAt: rev.appliedAt?.toISOString() ?? null,
      paths: files.map((f) => f.path),
    },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id, revisionId } = await params;
  const body = await readJsonBody<{ projectId?: string; action?: string; force?: boolean }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "editor"))) return forbidden();
  const ws = await workspaceOf(site.projectId);
  if (!ws) return Response.json({ error: "Site not found" }, { status: 404 });

  try {
    if (body?.action === "apply") {
      const out = await applySiteRevision({
        workspaceId: ws,
        projectId: site.projectId,
        siteId: site.id,
        revisionId,
        userId: user.id,
        force: body.force === true,
      });
      return Response.json({ ok: true, ...out });
    }
    if (body?.action === "discard") {
      await discardSiteRevision({ workspaceId: ws, siteId: site.id, revisionId });
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'action must be "apply" or "discard"' }, { status: 400 });
  } catch (err) {
    if (err instanceof SiteRevisionError) return Response.json({ error: err.message, code: err.code }, { status: err.status });
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
