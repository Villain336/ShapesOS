// Marketr — Wave 2 WFH mode slice 4: standup comment API.
// POST /api/wfh/standups/[id]/comments — add a comment to a visible standup.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { validateComment, WfhStandupError } from "@/lib/wfh/standups";

async function findVisible(workspaceId: string, userId: string, id: string) {
  return prisma.wfhStandup.findFirst({
    where: {
      id,
      workspaceId,
      OR: [{ visibility: "team" }, { userId }],
    },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const standup = await findVisible(workspace.id, user.id, id);
  if (!standup) return NextResponse.json({ error: "Standup not found" }, { status: 404 });

  let body: { body?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const v = validateComment(body.body);
    if (!v.ok || !v.text) throw new WfhStandupError("VALIDATION_FAILED", v.error ?? "Invalid comment");
    const comment = await prisma.wfhStandupComment.create({
      data: { standupId: standup.id, userId: user.id, body: v.text },
    });
    return NextResponse.json({ comment }, { status: 201 });
  } catch (err) {
    if (err instanceof WfhStandupError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    throw err;
  }
}
