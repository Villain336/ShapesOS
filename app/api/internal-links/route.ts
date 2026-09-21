// Marketr — internal-linking suggestions API (milestone 15).
// GET  /api/internal-links?projectId=…[&status=pending|applied|dismissed] → suggestions (viewer+).
// POST /api/internal-links { projectId, suggestionIds, action: "apply"|"dismiss" } (editor+).
// "Apply" is supervised: it marks the suggestion applied and opens an Issue
// in the fix-agent inbox with the exact edit to make — pages are never
// auto-edited.

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { REASON_LABELS } from "@/lib/seo/internal-links";

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
  const suggestions = await prisma.internalLinkSuggestion.findMany({
    where: {
      projectId: project.id,
      ...(status === "pending" || status === "applied" || status === "dismissed"
        ? { status: status as "pending" | "applied" | "dismissed" }
        : {}),
    },
    orderBy: { score: "desc" },
    take: 200,
  });
  return Response.json({ suggestions });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; suggestionIds?: string[]; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();
  if (
    (body.action !== "apply" && body.action !== "dismiss") ||
    !Array.isArray(body.suggestionIds) ||
    body.suggestionIds.length === 0
  ) {
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  const suggestions = await prisma.internalLinkSuggestion.findMany({
    where: { id: { in: body.suggestionIds }, projectId: project.id, status: "pending" },
  });

  const now = new Date();
  let issuesCreated = 0;
  for (const s of suggestions) {
    await prisma.internalLinkSuggestion.update({
      where: { id: s.id },
      data: { status: body.action === "apply" ? "applied" : "dismissed", decidedAt: now },
    });

    if (body.action === "apply") {
      // Supervised apply: open an inbox issue describing the exact edit.
      await prisma.issue.create({
        data: {
          projectId: project.id,
          type: "internal_link",
          severity: "info",
          url: s.sourceUrl,
          detailJson: {
            targetUrl: s.targetUrl,
            suggestedAnchor: s.suggestedAnchor,
            reason: s.reason,
            reasonLabel: REASON_LABELS[s.reason as keyof typeof REASON_LABELS] ?? s.reason,
            score: s.score,
            instruction: `Add an internal link from ${s.sourceUrl} to ${s.targetUrl} using anchor text "${s.suggestedAnchor}".`,
          },
          status: "open",
        },
      });
      issuesCreated += 1;
    }

    await prisma.fileChangeLog.create({
      data: {
        workspaceId: project.workspaceId,
        projectId: project.id,
        connectionId: null,
        filePath: "",
        actor: "system",
        action: body.action === "apply" ? "internal_link_suggestion_applied" : "internal_link_suggestion_dismissed",
        summary: `Internal-link suggestion ${body.action === "apply" ? "applied" : "dismissed"}: ${s.sourceUrl} → ${s.targetUrl} ("${s.suggestedAnchor}")`.slice(0, 280),
      },
    });
  }

  return Response.json({ ok: true, processed: suggestions.length, issuesCreated });
}
