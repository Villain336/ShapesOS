// Marketr — Wave 2 WFH mode slice 7: WFH day view API.
// GET /api/wfh/day — the Sunsama-pattern daily plan: today's focus blocks
// (recurring occurrences expanded), standup state, rituals due within 48h,
// and digest windows with queued counts. One call, one screen.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { buildDayView } from "@/lib/wfh/dayview";
import {
  isStandupDue,
  isStandupLate,
  nudgeCopy,
  standupDateFor,
  type StandupCadence,
} from "@/lib/wfh/standups";
import { nextOccurrence, RITUAL_TYPE_META, type RitualCadence, type RitualType } from "@/lib/wfh/rituals";
import { resolveTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/time/zoned";

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
  // "Today" is the user's local day in their IANA timezone (default UTC).
  const tz = resolveTimeZone(mode?.timezone);
  const local = zonedParts(now, tz);
  const dayStart = zonedTimeToUtc(local.year, local.month, local.day, 0, tz).date;
  const dayEnd = zonedTimeToUtc(local.year, local.month, local.day + 1, 0, tz).date;

  const [focusBlocks, todayStandup, subs, digestItems] = await Promise.all([
    prisma.wfhFocusBlock.findMany({
      where: {
        workspaceId: workspace.id,
        userId: user.id,
        status: { not: "cancelled" },
        // Pull blocks that could touch today: started before day end, and
        // (non-recurring ends after day start OR recurring of any kind).
        startAt: { lt: dayEnd },
        OR: [{ recurrence: { not: "none" } }, { endAt: { gte: dayStart } }],
      },
      orderBy: { startAt: "asc" },
      take: 100,
    }),
    prisma.wfhStandup.findFirst({
      where: { workspaceId: workspace.id, userId: user.id, date: standupDateFor(now, tz) },
      select: { id: true },
    }),
    prisma.wfhRitualSubscription.findMany({
      where: { userId: user.id, ritual: { workspaceId: workspace.id, active: true } },
      include: { ritual: true },
    }),
    prisma.wfhDigestItem.findMany({
      where: { workspaceId: workspace.id, userId: user.id, status: "queued" },
      select: { windowMin: true },
    }),
  ]);

  const cadence = (mode?.standupCadence ?? "daily") as StandupCadence;
  const due = isStandupDue(cadence, now, !!todayStandup, tz);
  const late = due && isStandupLate(now, 10, tz);

  const horizon = new Date(now.getTime() + 48 * 3600 * 1000);
  const ritualsDue = subs
    .map((s) => ({
      ritualId: s.ritual.id,
      type: s.ritual.type,
      title: s.ritual.title,
      prompt: RITUAL_TYPE_META[s.ritual.type as RitualType]?.prompt ?? null,
      nextOccurrence: nextOccurrence(s.ritual.anchorDate, s.ritual.cadence as RitualCadence, now, s.ritual.timezone),
    }))
    .filter((r) => r.nextOccurrence.getTime() <= horizon.getTime())
    .sort((a, b) => a.nextOccurrence.getTime() - b.nextOccurrence.getTime());

  const queuedByWindow = new Map<number, number>();
  for (const d of digestItems) {
    queuedByWindow.set(d.windowMin, (queuedByWindow.get(d.windowMin) ?? 0) + 1);
  }
  const digestWindows = [...queuedByWindow.entries()].map(([windowMin, queued]) => {
    const h = Math.floor(windowMin / 60);
    const m = windowMin % 60;
    const p = (n: number) => String(n).padStart(2, "0");
    return { time: `${p(h)}:${p(m)}`, label: `${p(h)}:${p(m)}`, queued };
  });

  const view = buildDayView({
    now,
    focusBlocks: focusBlocks.map((b) => ({
      id: b.id,
      title: b.title,
      startAt: b.startAt,
      endAt: b.endAt,
      recurrence: b.recurrence as "none" | "daily" | "weekdays" | "weekly",
      protection: b.protection,
      status: b.status,
    })),
    standup: { due, late, copy: nudgeCopy(due, late), submitted: !!todayStandup },
    ritualsDue,
    digestWindows,
    mode: mode?.mode ?? "office",
    timeZone: tz,
  });

  return NextResponse.json({
    day: {
      ...view,
      timeline: view.timeline.map((t) => ({
        ...t,
        startAt: t.startAt.toISOString(),
        endAt: t.endAt ? t.endAt.toISOString() : null,
      })),
    },
  });
}
