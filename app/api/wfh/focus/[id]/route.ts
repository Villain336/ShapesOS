// Marketr — Wave 2 WFH mode slice 3: focus-block status transitions.
// PATCH /api/wfh/focus/[id] — { status } through the legal transition graph
// (scheduled→protected→overridden/completed, etc.). Illegal moves fail closed.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { transitionStatus, FOCUS_STATUSES, WfhFocusError, type FocusStatus } from "@/lib/wfh/focus";

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
  let body: { status?: unknown };
  try {
    body = (await req.json()) as { status?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const target = String(body.status ?? "").toLowerCase();
  if (!(FOCUS_STATUSES as string[]).includes(target)) {
    return NextResponse.json(
      { error: `status must be one of: ${FOCUS_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  const block = await prisma.wfhFocusBlock.findFirst({
    where: { id, workspaceId: workspace.id, userId: user.id },
  });
  if (!block) return NextResponse.json({ error: "Focus block not found" }, { status: 404 });

  try {
    transitionStatus(block.status as FocusStatus, target as FocusStatus);
  } catch (err) {
    if (err instanceof WfhFocusError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    throw err;
  }

  const updated = await prisma.wfhFocusBlock.update({
    where: { id: block.id },
    data: { status: target },
  });
  return NextResponse.json({ block: updated });
}
