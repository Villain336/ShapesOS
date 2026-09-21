// Marketr — approve / ignore a single issue (milestone 10).
// PATCH /api/websites/[id]/issues/[issueId] { projectId, status: "approved" | "ignored" }
// Approval is the explicit per-issue gate for the scheduled rung.

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import { ownedSite } from "@/lib/connectors/source";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; issueId: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id, issueId } = await params;
  const body = await readJsonBody<{ projectId?: string; status?: string }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "editor"))) return forbidden();

  if (body?.status !== "approved" && body?.status !== "ignored") {
    return Response.json({ error: "status must be approved or ignored" }, { status: 400 });
  }

  const issue = await prisma.siteIssue.findFirst({ where: { id: issueId, siteId: site.id } });
  if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
  if (issue.status !== "open" && issue.status !== "approved") {
    return Response.json({ error: `Issue is already ${issue.status}` }, { status: 409 });
  }

  const updated = await prisma.siteIssue.update({
    where: { id: issue.id },
    data: {
      status: body.status,
      approvedBy: body.status === "approved" ? user.id : issue.approvedBy,
      approvedAt: body.status === "approved" ? new Date() : issue.approvedAt,
    },
  });
  return Response.json({ ok: true, issue: updated });
}
