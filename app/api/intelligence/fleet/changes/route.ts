// Marketr — Phase 10 M4: fleet changes API.
// GET  /api/intelligence/fleet/changes?projectId=&watchId=&changeType=&status=&q=&take=
// PATCH /api/intelligence/fleet/changes  { id, status }  (editor+)
//
// Status transitions are human review actions (new → reviewed / actioned /
// dismissed). Summaries stay PROPOSE-only: "actioned" means the human handled
// it outside Marketr (e.g. via the Phase 9 approval executor), never that
// the fleet acted.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import type { CompetitorChangeStatus, CompetitorChangeType } from "@prisma/client";

const STATUSES: CompetitorChangeStatus[] = ["new", "reviewed", "actioned", "dismissed"];

async function workspaceIdFor(userId: string, email?: string | null): Promise<string> {
  const { getOrCreateWorkspace } = await import("@/lib/session");
  return (await getOrCreateWorkspace(userId, email ?? "")).id;
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const projectId = sp.get("projectId") ?? undefined;
  const watchId = sp.get("watchId") ?? undefined;
  const changeType = sp.get("changeType") ?? undefined;
  const status = sp.get("status") ?? undefined;
  const q = sp.get("q")?.trim() || undefined;
  const take = Math.max(1, Math.min(Number(sp.get("take") ?? 50), 200));

  if (projectId && !(await requireProjectRole(user.id, projectId, "viewer"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const workspaceId = await workspaceIdFor(user.id, user.email);
  const changes = await withWorkspaceScope(workspaceId, (tx) =>
    tx.competitorChange.findMany({
      where: {
        workspaceId,
        ...(watchId ? { watchId } : {}),
        ...(changeType ? { changeType: changeType as CompetitorChangeType } : {}),
        ...(status ? { status: status as CompetitorChangeStatus } : {}),
        ...(q ? { url: { contains: q, mode: "insensitive" } } : {}),
        ...(projectId ? { watch: { projectId } } : {}),
      },
      include: { watch: { select: { competitorDomain: true, projectId: true } } },
      orderBy: { detectedAt: "desc" },
      take,
    }),
  );

  return Response.json({
    changes: changes.map((c) => ({
      id: c.id,
      watchId: c.watchId,
      projectId: c.watch.projectId,
      competitorDomain: c.watch.competitorDomain,
      url: c.url,
      detectedAt: c.detectedAt.toISOString(),
      changeType: c.changeType,
      semanticSummary: c.semanticSummary,
      whyItMatters: c.whyItMatters,
      recommendedResponse: c.recommendedResponse,
      status: c.status,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id || !STATUSES.includes(body.status as CompetitorChangeStatus)) {
    return Response.json({ error: "id and a valid status are required" }, { status: 400 });
  }

  const workspaceId = await workspaceIdFor(user.id, user.email);
  const updated = await withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.competitorChange.findFirst({
      where: { id: body.id, workspaceId },
      include: { watch: { select: { projectId: true } } },
    });
    if (!existing) return null;
    if (!(await requireProjectRole(user.id, existing.watch.projectId, "editor"))) return "forbidden";
    return tx.competitorChange.update({
      where: { id: body.id },
      data: { status: body.status as CompetitorChangeStatus },
      select: { id: true, status: true },
    });
  });

  if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
  if (updated === "forbidden") return Response.json({ error: "Forbidden" }, { status: 403 });
  return Response.json({ ok: true, change: updated });
}
