// Marketr — Wave 2 WFH mode slice 7: learning signals API.
// GET /api/wfh/signals — the caller's recent 13B learning-loop signals,
// newest first. Read-only window into what the preference loop is learning.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const signals = await prisma.wfhLearningSignal.findMany({
    where: { workspaceId: workspace.id, userId: user.id },
    orderBy: { occurredAt: "desc" },
    take: 50,
  });
  return NextResponse.json({ signals });
}
