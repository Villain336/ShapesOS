// Marketr — Wave 2 WFH mode slice 5: ritual subscription API.
// POST /api/wfh/rituals/[id]/subscribe — opt in.
// DELETE /api/wfh/rituals/[id]/subscribe — opt out.
// Rituals are opt-in by design; subscribing is the only way prompts reach you.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

async function findRitual(workspaceId: string, id: string) {
  return prisma.wfhRitual.findFirst({ where: { id, workspaceId, active: true } });
}

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
  const ritual = await findRitual(workspace.id, id);
  if (!ritual) return NextResponse.json({ error: "Ritual not found" }, { status: 404 });

  const sub = await prisma.wfhRitualSubscription.upsert({
    where: { ritualId_userId: { ritualId: ritual.id, userId: user.id } },
    create: { ritualId: ritual.id, userId: user.id },
    update: {},
  });
  return NextResponse.json({ subscription: sub }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const ritual = await prisma.wfhRitual.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!ritual) return NextResponse.json({ error: "Ritual not found" }, { status: 404 });

  await prisma.wfhRitualSubscription.deleteMany({
    where: { ritualId: ritual.id, userId: user.id },
  });
  return NextResponse.json({ ok: true });
}
