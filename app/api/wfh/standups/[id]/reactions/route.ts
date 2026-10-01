// Marketr — Wave 2 WFH mode slice 4: standup reaction API.
// POST /api/wfh/standups/[id]/reactions — one emoji per user per standup
// (resubmitting swaps the emoji). Reactions are async-acknowledgment, not
// performance scoring.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { validateReaction, WfhStandupError } from "@/lib/wfh/standups";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const standup = await prisma.wfhStandup.findFirst({
    where: {
      id,
      workspaceId: workspace.id,
      OR: [{ visibility: "team" }, { userId: user.id }],
    },
  });
  if (!standup) return NextResponse.json({ error: "Standup not found" }, { status: 404 });

  let body: { emoji?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const v = validateReaction(body.emoji);
    if (!v.ok || !v.normalized) throw new WfhStandupError("VALIDATION_FAILED", v.error ?? "Invalid reaction");
    const reaction = await prisma.wfhStandupReaction.upsert({
      where: { standupId_userId: { standupId: standup.id, userId: user.id } },
      create: { standupId: standup.id, userId: user.id, emoji: v.normalized },
      update: { emoji: v.normalized },
    });
    return NextResponse.json({ reaction }, { status: 201 });
  } catch (err) {
    if (err instanceof WfhStandupError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    throw err;
  }
}
