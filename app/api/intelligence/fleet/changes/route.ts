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
import { intQuery, parseQuery, z } from "@/lib/api/validate";

const STATUSES: CompetitorChangeStatus[] = ["new", "reviewed", "actioned", "dismissed"];
const CHANGE_TYPES: CompetitorChangeType[] = [
  "page_added",
  "page_removed",
  "content_updated",
  "metadata_updated",
  "structure_changed",
];

const ChangesQuerySchema = z.object({
  projectId: z.string().max(120).optional(),
  watchId: z.string().max(120).optional(),
  changeType: z.enum(CHANGE_TYPES as [CompetitorChangeType, ...CompetitorChangeType[]]).optional(),
  status: z.enum(STATUSES as [CompetitorChangeStatus, ...CompetitorChangeStatus[]]).optional(),
  q: z.string().max(500).optional(),
  take: intQuery(50, 1, 200),
});

async function workspaceIdFor(userId: string, email?: string | null): Promise<string> {
  const { getOrCreateWorkspace } = await import("@/lib/session");
  return (await getOrCreateWorkspace(userId, email ?? "")).id;
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // ?take=abc / ?take=1.5 / an unknown enum filter → 400, never a Prisma 500.
  const query = parseQuery(ChangesQuerySchema, req.nextUrl.searchParams);
  if (!query.ok) return query.error;
  const { projectId, watchId, changeType, status, take } = query.data;
  const q = query.data.q?.trim() || undefined;

  if (projectId && !(await requireProjectRole(user.id, projectId, "viewer"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const workspaceId = await workspaceIdFor(user.id, user.email);
  const changes = await withWorkspaceScope(workspaceId, (tx) =>
    tx.competitorChange.findMany({
      where: {
        workspaceId,
        ...(watchId ? { watchId } : {}),
        ...(changeType ? { changeType } : {}),
        ...(status ? { status } : {}),
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
      where: { id: body.id, workspaceId },
      data: { status: body.status as CompetitorChangeStatus },
      select: { id: true, status: true },
    });
  });

  if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
  if (updated === "forbidden") return Response.json({ error: "Forbidden" }, { status: 403 });
  return Response.json({ ok: true, change: updated });
}
