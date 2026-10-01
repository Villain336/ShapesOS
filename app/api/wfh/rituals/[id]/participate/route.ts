// Marketr — Wave 2 WFH mode slice 5: ritual participation API.
// POST /api/wfh/rituals/[id]/participate — log that you joined this round
// (optional note). Participating auto-subscribes you: you showed up, so the
// OS treats you as opted in.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

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
  const ritual = await prisma.wfhRitual.findFirst({
    where: { id, workspaceId: workspace.id, active: true },
  });
  if (!ritual) return NextResponse.json({ error: "Ritual not found" }, { status: 404 });

  let body: { note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const note = body.note != null ? String(body.note).trim().slice(0, 500) || null : null;

  const [participation] = await prisma.$transaction([
    prisma.wfhRitualParticipation.create({
      data: { ritualId: ritual.id, userId: user.id, note, occurredAt: new Date() },
    }),
    prisma.wfhRitualSubscription.upsert({
      where: { ritualId_userId: { ritualId: ritual.id, userId: user.id } },
      create: { ritualId: ritual.id, userId: user.id },
      update: {},
    }),
  ]);

  return NextResponse.json({ participation }, { status: 201 });
}
