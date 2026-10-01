// Marketr — Wave 2 WFH mode slice 3: focus-block CRUD API.
// GET /api/wfh/focus — list the caller's blocks (upcoming first).
// POST /api/wfh/focus — create a block (validated; recurrence is stored, not
// expanded — expansion happens on read via expandRecurrence).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { validateFocusBlock, WfhFocusError } from "@/lib/wfh/focus";
import { signalFocusCreated } from "@/lib/wfh/dayview";
import { recordLearningSignalSafe } from "@/lib/wfh/signals";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const blocks = await prisma.wfhFocusBlock.findMany({
    where: { workspaceId: workspace.id, userId: user.id },
    orderBy: { startAt: "asc" },
    take: 100,
  });
  return NextResponse.json({ blocks });
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

  try {
    const v = validateFocusBlock(body);
    if (!v.ok || !v.normalized) {
      throw new WfhFocusError("VALIDATION_FAILED", "Focus block is invalid.", v.errors);
    }
    const n = v.normalized;
    const block = await prisma.wfhFocusBlock.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        title: n.title,
        startAt: n.startAt,
        endAt: n.endAt,
        recurrence: n.recurrence,
        protection: n.protection,
        source: n.source,
        status: "scheduled",
      },
    });
    // 13B learning-loop hook (best-effort).
    await recordLearningSignalSafe(
      workspace.id,
      user.id,
      signalFocusCreated({
        id: block.id,
        protection: block.protection,
        recurrence: block.recurrence,
        startAt: block.startAt,
        endAt: block.endAt,
      }),
    );
    return NextResponse.json({ block }, { status: 201 });
  } catch (err) {
    if (err instanceof WfhFocusError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: 422 },
      );
    }
    throw err;
  }
}
