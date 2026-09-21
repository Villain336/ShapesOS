// Marketr — retry a failed/queued alert event (milestone 13).
// POST /api/alerts/[id]/retry → { event }
// Re-delivers to the rule's currently-enabled channels. Writes: editor+.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { deliverEvent } from "@/lib/alerts/dispatch";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  const { id } = await params;
  const event = await prisma.alertEvent.findFirst({
    where: { id, workspaceId: workspace.id },
    include: { rule: { select: { id: true, name: true, enabled: true } } },
  });
  if (!event) return Response.json({ error: "Event not found" }, { status: 404 });
  if (event.status === "suppressed") {
    return Response.json({ error: "Suppressed events cannot be retried" }, { status: 400 });
  }
  if (!event.rule.enabled) {
    return Response.json({ error: "The rule is disabled — enable it first" }, { status: 400 });
  }

  const delivered = await deliverEvent(event.id);
  return Response.json({
    event: {
      id: delivered.id,
      status: delivered.status,
      results: delivered.results,
      retryCount: delivered.retryCount,
      sentAt: delivered.sentAt?.toISOString() ?? null,
    },
  });
}
