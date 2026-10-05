// Marketr — Wave 2 WFH mode slice 4: async standups feed API.
// GET /api/wfh/standups — team feed: team-visible standups from all members
// plus the caller's own private ones, newest first, with threads attached.
// POST /api/wfh/standups — submit today's standup (one per user per day;
// resubmitting updates the existing entry).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { validateStandup, WfhStandupError, isStandupLate } from "@/lib/wfh/standups";
import { resolveTimeZone } from "@/lib/time/zoned";
import { signalStandupSubmitted } from "@/lib/wfh/dayview";
import { recordLearningSignalSafe } from "@/lib/wfh/signals";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const standups = await prisma.wfhStandup.findMany({
    where: {
      workspaceId: workspace.id,
      OR: [{ visibility: "team" }, { userId: user.id }],
    },
    include: {
      comments: { orderBy: { createdAt: "asc" } },
      reactions: true,
    },
    orderBy: { date: "desc" },
    take: 30,
  });
  return NextResponse.json({ standups });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // The user's local workday ("YYYY-MM-DD" is taken as-is; an instant is
  // read in their IANA timezone).
  const mode = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    select: { timezone: true },
  });
  const tz = resolveTimeZone(mode?.timezone);

  try {
    const v = validateStandup({
      date: body.date ? String(body.date) : new Date(),
      yesterday: String(body.yesterday ?? ""),
      today: String(body.today ?? ""),
      blockers: body.blockers != null ? String(body.blockers) : null,
      videoUrl: body.videoUrl != null ? String(body.videoUrl) : null,
      visibility: (body.visibility as "team" | "private" | undefined) ?? "team",
    }, tz);
    if (!v.ok || !v.normalized) {
      throw new WfhStandupError("VALIDATION_FAILED", "Standup is invalid.", v.errors);
    }
    const n = v.normalized;
    const standup = await prisma.wfhStandup.upsert({
      where: {
        workspaceId_userId_date: {
          workspaceId: workspace.id,
          userId: user.id,
          date: n.date,
        },
      },
      create: {
        workspaceId: workspace.id,
        userId: user.id,
        date: n.date,
        yesterday: n.yesterday,
        today: n.today,
        blockers: n.blockers,
        videoUrl: n.videoUrl,
        visibility: n.visibility,
      },
      update: {
        yesterday: n.yesterday,
        today: n.today,
        blockers: n.blockers,
        videoUrl: n.videoUrl,
        visibility: n.visibility,
      },
    });
    await recordLearningSignalSafe(
      workspace.id,
      user.id,
      signalStandupSubmitted({
        standupId: standup.id,
        late: isStandupLate(new Date(), 10, tz),
        visibility: standup.visibility,
        hasBlockers: !!standup.blockers,
        hasVideo: !!standup.videoUrl,
      }),
    );
    return NextResponse.json({ standup }, { status: 201 });
  } catch (err) {
    if (err instanceof WfhStandupError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: 422 },
      );
    }
    throw err;
  }
}
