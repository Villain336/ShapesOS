// Marketr — backlink intelligence API (milestone 15).
// GET  /api/backlinks?projectId=…[&status=active|lost][&dofollow=1][&q=…] → summary + links (viewer+).
// POST /api/backlinks { projectId, action: "preview", limit?, target? } → cost preview (editor+).
// The actual pull lives at POST /api/backlinks/pull (same editor+ bar).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { previewBacklinkPull, monthlyBacklinkSpendUsd } from "@/lib/seo/backlink-pull";
import { DEFAULT_MONTHLY_SPEND_CAP_USD } from "@/lib/seo/backlinks-cost";

export const dynamic = "force-dynamic";

async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true, domain: true },
  });
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) return forbidden();

  const status = req.nextUrl.searchParams.get("status");
  const dofollowOnly = req.nextUrl.searchParams.get("dofollow") === "1";
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();

  const where = {
    projectId: project.id,
    ...(status === "active" || status === "lost" ? { status: status as "active" | "lost" } : {}),
    ...(dofollowOnly ? { dofollow: true } : {}),
    ...(q
      ? {
          OR: [
            { anchorText: { contains: q, mode: "insensitive" as const } },
            { sourceDomain: { contains: q, mode: "insensitive" as const } },
            { sourceUrl: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [links, summary, counts, workspace] = await Promise.all([
    prisma.backlink.findMany({
      where,
      orderBy: [{ status: "asc" }, { sourceRank: "desc" }],
      take: 500,
    }),
    prisma.backlinkSummary.findMany({
      where: { projectId: project.id },
      orderBy: { date: "desc" },
      take: 30,
    }),
    prisma.backlink.groupBy({
      by: ["status"],
      where: { projectId: project.id },
      _count: true,
    }),
    prisma.workspace.findUnique({
      where: { id: project.workspaceId },
      select: { backlinksSpendCapUsd: true },
    }),
  ]);

  const spendUsedUsd = await monthlyBacklinkSpendUsd(project.workspaceId);
  const spendCapUsd = workspace?.backlinksSpendCapUsd ?? DEFAULT_MONTHLY_SPEND_CAP_USD;

  return Response.json({
    links,
    summary,
    latestSummary: summary[0] ?? null,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    spend: { usedUsd: spendUsedUsd, capUsd: spendCapUsd, custom: workspace?.backlinksSpendCapUsd != null },
    domain: project.domain,
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; action?: string; limit?: number; target?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();
  if (body.action !== "preview") return Response.json({ error: "Invalid action" }, { status: 400 });

  const limit = Math.max(1, Math.min(100_000, Math.floor(body.limit ?? 500)));
  const preview = await previewBacklinkPull(
    project.workspaceId,
    project.id,
    body.target?.trim() || project.domain,
    limit,
    "user",
  );
  return Response.json({ preview });
}
