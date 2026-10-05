// ShapesOS Phase 11 (seotools): a site's sitemap.
// GET  /api/websites/[id]/sitemap?projectId=…  → recent submissions
// POST /api/websites/[id]/sitemap { projectId, action: "rebuild" }
//      → write sitemap.xml + robots.txt Sitemap line + IndexNow key file into
//        the working copy (the same rebuild that runs on draft apply / deploy)
// POST /api/websites/[id]/sitemap { projectId, action: "submit", targets? }
//      → submit to Search Console (when connected) and IndexNow; every
//        attempt is recorded with its real status (lib/seo/sitemap-submit.ts)

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/sitefiles/api";
import { getSiteIdeProvider, ownedSite } from "@/lib/connectors/source";
import { refreshSiteSitemap } from "@/lib/seo/sitemap";
import { listSitemapSubmissions, submitSiteSitemap, SitemapSubmitError, type SubmitTarget } from "@/lib/seo/sitemap-submit";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const site = await ownedSite(user.id, req.nextUrl.searchParams.get("projectId") ?? "", id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "viewer"))) return forbidden();
  const project = await prisma.project.findUnique({ where: { id: site.projectId }, select: { workspaceId: true } });
  if (!project) return Response.json({ error: "Site not found" }, { status: 404 });
  const rows = await listSitemapSubmissions(project.workspaceId, site.id);
  return Response.json({
    ok: true,
    submissions: rows.map((r) => ({
      id: r.id,
      target: r.target,
      status: r.status,
      sitemapUrl: r.sitemapUrl,
      urlCount: r.urlCount,
      httpStatus: r.httpStatus,
      detail: r.detail,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody<{ projectId?: string; action?: string; targets?: unknown }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "editor"))) return forbidden();
  const project = await prisma.project.findUnique({ where: { id: site.projectId }, select: { workspaceId: true } });
  if (!project) return Response.json({ error: "Site not found" }, { status: 404 });

  if (body?.action === "rebuild") {
    const res = await refreshSiteSitemap({ siteId: site.id, projectId: site.projectId, provider: await getSiteIdeProvider(site) });
    if (res.skipped === "no_origin") {
      return Response.json({ error: "The site has no live URL yet — deploy it or set the project domain first." }, { status: 400 });
    }
    return Response.json({ ok: true, ...res });
  }
  if (body?.action === "submit") {
    const targets = Array.isArray(body.targets)
      ? body.targets.filter((t): t is SubmitTarget => t === "gsc" || t === "indexnow")
      : undefined;
    try {
      const out = await submitSiteSitemap({
        workspaceId: project.workspaceId,
        projectId: site.projectId,
        siteId: site.id,
        targets,
        submittedBy: user.id,
      });
      return Response.json({ ok: true, ...out });
    } catch (err) {
      if (err instanceof SitemapSubmitError) return Response.json({ error: err.message, code: err.code }, { status: 400 });
      return errorResponse(err, "sitemap-submit");
    }
  }
  return Response.json({ error: 'action must be "rebuild" or "submit"' }, { status: 400 });
}
