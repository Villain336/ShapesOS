// Marketr — Wave 2 WFH mode slice 2: notification routing API.
// POST /api/wfh/notifications/route — submit a notification; the router decides
// "now" (urgent breakthrough) vs "digest" (queued for the next window).
// Body: { kind, title, body?, link?, urgentOverride? }.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  routeNotification,
  classifyUrgency,
  resolveDigestWindows,
  type RoutableNotification,
} from "@/lib/wfh/notifications";
import type { WorkModeState } from "@/lib/wfh/mode";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: RoutableNotification;
  try {
    body = (await req.json()) as RoutableNotification;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.kind || !body.title) {
    return NextResponse.json({ error: "kind and title are required" }, { status: 400 });
  }

  const row = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
  });
  const mode: WorkModeState | null = row
    ? {
        mode: row.mode as WorkModeState["mode"],
        wfhDays: row.wfhDays,
        setupCompletedAt: row.setupCompletedAt,
        timezone: row.timezone,
      }
    : null;

  const decision = routeNotification(body, {
    mode,
    notificationProfile: (row?.notificationProfile ?? "batched") as "realtime" | "batched",
    at: new Date(),
    digestTimesMin: row?.digestTimesMin ?? null,
  });

  let queuedItem = null;
  if (decision.deliver === "digest") {
    queuedItem = await prisma.wfhDigestItem.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        kind: body.kind,
        title: body.title.slice(0, 280),
        body: body.body?.slice(0, 2000) ?? null,
        link: body.link?.slice(0, 500) ?? null,
        urgency: classifyUrgency(body),
        windowMin: decision.windowMin,
        status: "queued",
      },
    });
  }

  return NextResponse.json({
    decision,
    queuedItemId: queuedItem?.id ?? null,
    digestWindows: resolveDigestWindows(row?.digestTimesMin ?? null).timesMin,
  });
}
