// Marketr — Wave 2 WFH mode slice 5: retire/reactivate a ritual.
// PATCH /api/wfh/rituals/[id] — { active }. Dead rituals are retired by the
// team, never auto-deleted.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { signalRitualRetired } from "@/lib/wfh/dayview";
import { recordLearningSignalSafe } from "@/lib/wfh/signals";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  let body: { active?: unknown; wasDead?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.active !== "boolean") {
    return NextResponse.json({ error: "active must be a boolean" }, { status: 400 });
  }

  const ritual = await prisma.wfhRitual.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!ritual) return NextResponse.json({ error: "Ritual not found" }, { status: 404 });

  const updated = await prisma.wfhRitual.update({
    where: { id: ritual.id },
    data: { active: body.active },
  });
  if (!body.active) {
    // 13B learning-loop hook (best-effort). wasDead comes from the client's
    // health verdict — the team saw the dead-ritual surfacing and acted.
    await recordLearningSignalSafe(
      workspace.id,
      user.id,
      signalRitualRetired({
        ritualId: ritual.id,
        ritualType: ritual.type,
        wasDead: body.wasDead === true,
      }),
    );
  }
  return NextResponse.json({ ritual: updated });
}
