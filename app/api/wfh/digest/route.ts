// Marketr — Wave 2 WFH mode slice 2: digest queue API.
// GET /api/wfh/digest — the caller's queued digest items, due windows right
// now, and the assembled digest preview per due window.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  resolveDigestWindows,
  dueWindowsFor,
  assembleDigest,
} from "@/lib/wfh/notifications";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const row = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
  });
  const windows = resolveDigestWindows(row?.digestTimesMin ?? null).timesMin;
  const now = new Date();

  const queued = await prisma.wfhDigestItem.findMany({
    where: { workspaceId: workspace.id, userId: user.id, status: "queued" },
    orderBy: [{ windowMin: "asc" }, { queuedAt: "asc" }],
    take: 200,
  });

  // Last flush per window = latest sentAt among sent items for that window.
  const sent = await prisma.wfhDigestItem.findMany({
    where: { workspaceId: workspace.id, userId: user.id, status: "sent", sentAt: { not: null } },
    select: { windowMin: true, sentAt: true },
    orderBy: { sentAt: "desc" },
    take: 200,
  });
  const lastFlushedAt: Record<number, string | null> = {};
  for (const s of sent) {
    if (!(s.windowMin in lastFlushedAt) && s.sentAt) {
      lastFlushedAt[s.windowMin] = s.sentAt.toISOString();
    }
  }

  const due = dueWindowsFor(windows, now, lastFlushedAt);
  const previews = due.map((windowMin) => {
    const items = queued
      .filter((q) => q.windowMin === windowMin)
      .map((q) => ({
        kind: q.kind,
        title: q.title,
        body: q.body ?? undefined,
        link: q.link ?? undefined,
        queuedAt: q.queuedAt.toISOString(),
      }));
    return assembleDigest(windowMin, items);
  });

  return NextResponse.json({
    digestWindows: windows,
    dueWindows: due,
    previews,
    queued: queued.map((q) => ({
      id: q.id,
      kind: q.kind,
      title: q.title,
      windowMin: q.windowMin,
      queuedAt: q.queuedAt.toISOString(),
    })),
  });
}
