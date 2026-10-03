// Marketr — Wave 2 WFH mode slice 5: rituals due soon.
// GET /api/wfh/rituals/due — subscribed, active rituals whose next occurrence
// is within the next 48 hours, with the ritual's prompt copy. Feeds the
// day-view reminders (slice 7).

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { nextOccurrence, RITUAL_TYPE_META, type RitualCadence, type RitualType } from "@/lib/wfh/rituals";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const now = new Date();
  const horizon = new Date(now.getTime() + 48 * 3600 * 1000);

  const subs = await prisma.wfhRitualSubscription.findMany({
    where: { userId: user.id, ritual: { workspaceId: workspace.id, active: true } },
    include: { ritual: true },
  });

  const due = subs
    .map((s) => {
      const next = nextOccurrence(s.ritual.anchorDate, s.ritual.cadence as RitualCadence, now, s.ritual.timezone);
      return {
        ritualId: s.ritual.id,
        type: s.ritual.type,
        title: s.ritual.title,
        prompt: RITUAL_TYPE_META[s.ritual.type as RitualType]?.prompt ?? null,
        nextOccurrence: next.toISOString(),
      };
    })
    .filter((d) => new Date(d.nextOccurrence).getTime() <= horizon.getTime())
    .sort((a, b) => a.nextOccurrence.localeCompare(b.nextOccurrence));

  return NextResponse.json({ due });
}
