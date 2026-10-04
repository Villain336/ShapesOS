// ShapesOS Phase 11 (seotools): JSON-LD for a site's pages.
// GET  /api/websites/[id]/structured-data?projectId=…  → preview: which blocks
//      each page would get (no writes)
// POST /api/websites/[id]/structured-data { projectId, pages? } → save them as a
//      DRAFT revision (lib/seo/jsonld-draft.ts). Never writes the live working
//      copy: a person applies the draft in Site drafts, then deploys.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/sitefiles/api";
import { ownedSite } from "@/lib/connectors/source";
import { createJsonLdDraft, JsonLdDraftError, planJsonLd } from "@/lib/seo/jsonld-draft";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

function errorResponse(err: unknown) {
  if (err instanceof JsonLdDraftError) {
    return Response.json({ error: err.message, code: err.code, issues: err.issues }, { status: err.code === "invalid_block" ? 422 : 400 });
  }
  return errorResponse(err, "structured-data");
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const site = await ownedSite(user.id, req.nextUrl.searchParams.get("projectId") ?? "", id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "viewer"))) return forbidden();
  const project = await prisma.project.findUnique({ where: { id: site.projectId }, select: { workspaceId: true } });
  if (!project) return Response.json({ error: "Site not found" }, { status: 404 });
  try {
    const plan = await planJsonLd({ workspaceId: project.workspaceId, projectId: site.projectId, siteId: site.id });
    return Response.json({ ok: true, origin: plan.identity.origin, pages: plan.pages });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody<{ projectId?: string; pages?: unknown }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "editor"))) return forbidden();
  const project = await prisma.project.findUnique({ where: { id: site.projectId }, select: { workspaceId: true } });
  if (!project) return Response.json({ error: "Site not found" }, { status: 404 });
  const pages = Array.isArray(body?.pages) ? body.pages.filter((p): p is string => typeof p === "string").slice(0, 2000) : undefined;
  try {
    const res = await createJsonLdDraft({
      workspaceId: project.workspaceId,
      projectId: site.projectId,
      siteId: site.id,
      paths: pages,
      createdBy: user.id,
    });
    return Response.json({
      ok: true,
      saved: !!res.revision,
      revision: res.revision ? { id: res.revision.id, number: res.revision.number } : null,
      pages: res.pages,
      origin: res.origin,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
