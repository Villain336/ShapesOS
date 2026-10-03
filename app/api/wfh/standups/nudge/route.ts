// Marketr — Wave 2 WFH mode slice 4: standup nudge API.
// GET /api/wfh/standups/nudge — is the caller's standup due today? Returns
// { due, late, copy }. A nudge, never a mandate: nothing downstream gates on
// this value.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  isStandupDue,
  isStandupLate,
  nudgeCopy,
  standupDateFor,
  type StandupCadence,
} from "@/lib/wfh/standups";
import { resolveTimeZone } from "@/lib/time/zoned";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const now = new Date();
  const mode = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
  });
  const cadence = (mode?.standupCadence ?? "daily") as StandupCadence;
  const tz = resolveTimeZone(mode?.timezone);

  const today = await prisma.wfhStandup.findFirst({
    where: {
      workspaceId: workspace.id,
      userId: user.id,
      date: standupDateFor(now, tz),
    },
    select: { id: true },
  });

  const due = isStandupDue(cadence, now, !!today, tz);
  const late = due && isStandupLate(now, 10, tz);
  return NextResponse.json({ due, late, copy: nudgeCopy(due, late), cadence });
}
