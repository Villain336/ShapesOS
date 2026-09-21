// Marketr — single workspace member API (milestone 11: RBAC).
// PATCH  /api/workspace/members/[id] { role } → change role (admin+)
// DELETE /api/workspace/members/[id]          → remove (admin+)
// The last owner cannot be demoted or removed.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { readJsonBody } from "@/lib/sitefiles/api";
import type { WorkspaceRole } from "@prisma/client";

const VALID_ROLES: WorkspaceRole[] = ["owner", "admin", "editor", "viewer"];

async function audit(
  workspaceId: string,
  actor: string,
  action: "member_role_changed" | "member_removed",
  summary: string,
) {
  await prisma.fileChangeLog.create({
    data: {
      projectId: null,
      workspaceId,
      filePath: "(workspace)",
      actor: "user",
      action,
      summary,
      approvedBy: actor,
    },
  });
}

async function ownerCount(workspaceId: string) {
  return prisma.workspaceMember.count({ where: { workspaceId, role: "owner" } });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin")))
    return forbidden("Member management requires the admin role.");

  const { id } = await params;
  const body = await readJsonBody<{ role?: string }>(req);
  const role = (body?.role ?? "").trim().toLowerCase() as WorkspaceRole;
  if (!VALID_ROLES.includes(role))
    return Response.json({ error: "Invalid role." }, { status: 400 });

  const member = await prisma.workspaceMember.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!member) return Response.json({ error: "Member not found" }, { status: 404 });

  if (member.role === "owner" && role !== "owner" && (await ownerCount(workspace.id)) <= 1)
    return Response.json(
      { error: "Cannot demote the last owner of the workspace." },
      { status: 400 },
    );

  const updated = await prisma.workspaceMember.update({
    where: { id: member.id },
    data: { role },
  });
  await audit(
    workspace.id,
    user.id,
    "member_role_changed",
    `${user.email ?? user.id} changed ${member.email ?? member.id} from ${member.role} to ${role}`,
  );
  return Response.json({ ok: true, member: { id: updated.id, role: updated.role } });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin")))
    return forbidden("Member management requires the admin role.");

  const { id } = await params;
  const member = await prisma.workspaceMember.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!member) return Response.json({ error: "Member not found" }, { status: 404 });

  if (member.role === "owner" && (await ownerCount(workspace.id)) <= 1)
    return Response.json(
      { error: "Cannot remove the last owner of the workspace." },
      { status: 400 },
    );

  await prisma.workspaceMember.delete({ where: { id: member.id } });
  await audit(
    workspace.id,
    user.id,
    "member_removed",
    `${user.email ?? user.id} removed ${member.email ?? member.id} (${member.role})`,
  );
  return Response.json({ ok: true });
}
