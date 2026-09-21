// Marketr — review monitoring API (milestone 16).
// GET   /api/local/reviews?projectId=…[&rating=1..5][&sentiment=pos|neu|neg][&responded=0|1][&q=…] (viewer+).
// PATCH /api/local/reviews { reviewId, responded } → mark responded/unresponded (editor+).
// POST  /api/local/reviews { projectId, action: "ingest" } → ingest now (editor+).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ingestReviews } from "@/lib/local/service";

export const dynamic = "force-dynamic";

async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) return forbidden();

  const sp = req.nextUrl.searchParams;
  const rating = Number(sp.get("rating"));
  const sentiment = sp.get("sentiment");
  const responded = sp.get("responded");
  const q = (sp.get("q") ?? "").trim();

  const where = {
    projectId: project.id,
    ...(Number.isInteger(rating) && rating >= 1 && rating <= 5 ? { rating } : {}),
    ...(sentiment === "pos" || sentiment === "neu" || sentiment === "neg" ? { sentiment: sentiment as "pos" | "neu" | "neg" } : {}),
    ...(responded === "0" ? { responded: false } : responded === "1" ? { responded: true } : {}),
    ...(q
      ? { OR: [{ text: { contains: q, mode: "insensitive" as const } }, { author: { contains: q, mode: "insensitive" as const } }] }
      : {}),
  };

  const [reviews, summary, counts] = await Promise.all([
    prisma.review.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.reviewSummary.findFirst({
      where: { projectId: project.id },
      orderBy: { periodStart: "desc" },
    }),
    prisma.review.groupBy({ by: ["sentiment"], where: { projectId: project.id }, _count: true }),
  ]);

  return Response.json({ reviews, summary, counts });
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { reviewId?: string; responded?: boolean };
  try {
    body = (await req.json()) as { reviewId?: string; responded?: boolean };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.reviewId !== "string" || typeof body.responded !== "boolean") {
    return Response.json({ error: "reviewId and responded are required" }, { status: 400 });
  }

  const review = await prisma.review.findFirst({
    where: { id: body.reviewId, project: { workspace: accessibleWorkspaceWhere(user.id) } },
    select: { id: true, projectId: true },
  });
  if (!review) return Response.json({ error: "Review not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, review.projectId, "editor"))) return forbidden();

  const updated = await prisma.review.update({
    where: { id: review.id },
    data: { responded: body.responded },
  });
  return Response.json({ review: updated });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.action !== "ingest") {
    return Response.json({ error: 'action must be "ingest"' }, { status: 400 });
  }

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  const result = await ingestReviews(project.id, `user:${user.id}`);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ result });
}
