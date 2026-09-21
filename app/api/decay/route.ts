// Marketr — content decay findings API (milestone 14).
// GET  /api/decay?projectId=…[&status=open] → findings (viewer+).
// POST /api/decay { findingId, action: "dismiss" | "create_brief" } (editor+).
//   create_brief → creates a ContentItem (milestone 4 brief) linked to the
//   finding's representative keyword, and marks the finding actioned.

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["open", "actioned", "dismissed"]);

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

  const status = req.nextUrl.searchParams.get("status") ?? "open";
  if (!STATUSES.has(status)) return Response.json({ error: "Invalid status" }, { status: 400 });

  const findings = await prisma.contentDecayFinding.findMany({
    where: { projectId: project.id, status },
    orderBy: [{ decayScore: "desc" }, { detectedAt: "desc" }],
  });
  return Response.json({ findings });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; findingId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  const finding = await prisma.contentDecayFinding.findFirst({
    where: { id: body.findingId ?? "", projectId: project.id, status: "open" },
  });
  if (!finding) return Response.json({ error: "Finding not found" }, { status: 404 });

  if (body.action === "dismiss") {
    await prisma.contentDecayFinding.update({
      where: { id: finding.id },
      data: { status: "dismissed", resolvedAt: new Date(), note: `Dismissed by ${user.email ?? "user"}.` },
    });
  } else if (body.action === "create_brief") {
    // Feed the milestone 4 content pipeline: a brief linked to the
    // representative keyword (or unlinked when the finding has none).
    const item = await prisma.contentItem.create({
      data: {
        projectId: project.id,
        keywordId: finding.keywordId,
        status: "brief",
        outlineJson: {
          source: "decay_finding",
          findingId: finding.id,
          url: finding.url,
          phrases: finding.phrases,
          peakPosition: finding.peakPosition,
          currentPosition: finding.currentPosition,
          suggestedAction: finding.suggestedAction,
        },
      },
    });
    await prisma.contentDecayFinding.update({
      where: { id: finding.id },
      data: {
        status: "actioned",
        resolvedAt: new Date(),
        note: `Refresh brief created (${item.id}).`,
      },
    });
    return Response.json({ ok: true, contentItemId: item.id });
  } else {
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  await prisma.fileChangeLog
    .create({
      data: {
        workspaceId: project.workspaceId,
        projectId: project.id,
        connectionId: null,
        filePath: "",
        actor: "user",
        action: "decay_finding_resolved",
        summary: `Decay finding ${body.action === "dismiss" ? "dismissed" : "actioned"}: ${finding.url ?? finding.phrases[0] ?? finding.id}`,
        approvedBy: user.id,
      },
    })
    .catch(() => {});

  return Response.json({ ok: true });
}
