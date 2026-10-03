// Marketr — Wave 2 WFH mode slice 3: conflict preview API.
// POST /api/wfh/focus/[id]/check-conflicts — preview conflicts + soft
// reschedule suggestions against a caller-supplied event list, without
// changing the block's status. Pure preview; enforcement is a separate call.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { resolveTimeZone } from "@/lib/time/zoned";
import {
  findConflicts,
  suggestReschedules,
  type CalendarEventLike,
} from "@/lib/wfh/focus";

interface EventInput {
  id?: unknown;
  title?: unknown;
  startAt?: unknown;
  endAt?: unknown;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  let body: { events?: EventInput[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const block = await prisma.wfhFocusBlock.findFirst({
    where: { id, workspaceId: workspace.id, userId: user.id },
  });
  if (!block) return NextResponse.json({ error: "Focus block not found" }, { status: 404 });

  const events: CalendarEventLike[] = (Array.isArray(body.events) ? body.events : [])
    .map((e, i) => {
      const startAt = new Date(String(e.startAt ?? ""));
      const endAt = new Date(String(e.endAt ?? ""));
      if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) return null;
      return {
        id: String(e.id ?? `manual-${i}`),
        title: String(e.title ?? "Untitled event"),
        startAt,
        endAt,
      };
    })
    .filter((e): e is CalendarEventLike => e !== null);

  const conflicts = findConflicts({ startAt: block.startAt, endAt: block.endAt }, events);
  const mode = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    select: { timezone: true },
  });
  const suggestions = suggestReschedules(
    { startAt: block.startAt, endAt: block.endAt },
    conflicts,
    events,
    resolveTimeZone(mode?.timezone),
  );

  return NextResponse.json({
    conflicts,
    suggestions: suggestions.map((s) => ({
      ...s,
      suggestedStartAt: s.suggestedStartAt.toISOString(),
      suggestedEndAt: s.suggestedEndAt.toISOString(),
    })),
  });
}
