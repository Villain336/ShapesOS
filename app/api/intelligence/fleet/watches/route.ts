// Marketr — Phase 10 M4: competitor watchlist API.
// GET    /api/intelligence/fleet/watches?projectId=
// POST   /api/intelligence/fleet/watches  { projectId, competitorDomain, sitemapUrl? }  (editor+)
// DELETE /api/intelligence/fleet/watches?id=  (editor+)
//
// Creating a watch only registers the competitor — the weekly cron does the
// fetching. Domain is normalized (bare registrable domain).

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireProjectRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { normalizeDomain } from "@/lib/competitors";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/safe-url";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  if (projectId && !(await requireProjectRole(user.id, projectId, "viewer"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const workspaceId = (await getOrCreateWorkspace(user.id, user.email)).id;
  const watches = await withWorkspaceScope(workspaceId, (tx) =>
    tx.competitorWatch.findMany({
      where: { workspaceId, ...(projectId ? { projectId } : {}) },
      select: {
        id: true,
        projectId: true,
        competitorDomain: true,
        sitemapUrl: true,
        lastDiffAt: true,
        _count: { select: { changes: true } },
      },
      orderBy: { competitorDomain: "asc" },
    }),
  );

  return Response.json({
    watches: watches.map((w) => ({
      id: w.id,
      projectId: w.projectId,
      competitorDomain: w.competitorDomain,
      sitemapUrl: w.sitemapUrl,
      lastDiffAt: w.lastDiffAt?.toISOString() ?? null,
      changeCount: w._count.changes,
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; competitorDomain?: string; sitemapUrl?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
  if (!(await requireProjectRole(user.id, body.projectId, "editor"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const domain = normalizeDomain(body.competitorDomain);
  if (!domain) return Response.json({ error: "valid competitorDomain is required" }, { status: 400 });
  let sitemapUrl: string | null = (body.sitemapUrl ?? "").trim() || null;
  if (sitemapUrl && !/^https?:\/\//i.test(sitemapUrl)) {
    return Response.json({ error: "sitemapUrl must be an absolute http(s) URL" }, { status: 400 });
  }
  if (sitemapUrl) {
    // H8: refuse internal targets up front (the fleet's safeFetch re-checks
    // every request and redirect hop at crawl time too).
    try {
      await assertSafeUrl(sitemapUrl);
    } catch (err) {
      const msg = err instanceof UnsafeUrlError ? err.message : "sitemapUrl is not allowed";
      return Response.json({ error: `sitemapUrl refused: ${msg}` }, { status: 400 });
    }
  }

  const workspaceId = (await getOrCreateWorkspace(user.id, user.email)).id;
  const watch = await withWorkspaceScope(workspaceId, (tx) =>
    tx.competitorWatch.upsert({
      where: { projectId_competitorDomain: { projectId: body.projectId!, competitorDomain: domain }, workspaceId },
      create: {
        workspaceId,
        projectId: body.projectId!,
        competitorDomain: domain,
        sitemapUrl,
      },
      update: { sitemapUrl },
      select: { id: true, competitorDomain: true, sitemapUrl: true },
    }),
  );

  return Response.json({ ok: true, watch });
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const workspaceId = (await getOrCreateWorkspace(user.id, user.email)).id;
  const done = await withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.competitorWatch.findFirst({
      where: { id, workspaceId },
      select: { id: true, projectId: true },
    });
    if (!existing) return null;
    if (!(await requireProjectRole(user.id, existing.projectId, "editor"))) return "forbidden";
    await tx.competitorWatch.delete({ where: { id, workspaceId } });
    return true;
  });

  if (!done) return Response.json({ error: "Not found" }, { status: 404 });
  if (done === "forbidden") return Response.json({ error: "Forbidden" }, { status: 403 });
  return Response.json({ ok: true });
}
