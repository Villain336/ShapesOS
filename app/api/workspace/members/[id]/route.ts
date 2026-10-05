// Marketr — single workspace member API (milestone 11: RBAC).
// PATCH  /api/workspace/members/[id] { role } → change role (admin+)
// DELETE /api/workspace/members/[id]          → remove (admin+)
// Phase 1: nobody grants above their own role, only owners touch owner rows,
// and the last ACTIVE owner (pending owner invites don't count) cannot be
// demoted or removed.

import type { NextRequest } from "next/server";
import { syncSeatsBestEffort } from "@/lib/billing/seats-server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import {
  activeOwnerCount,
  forbidden,
  memberChangeError,
  requireWorkspaceRole,
} from "@/lib/authz";
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!me) return forbidden("Member management requires the admin role.");

  const { id } = await params;
  const body = await readJsonBody<{ role?: string }>(req);
  const role = (body?.role ?? "").trim().toLowerCase() as WorkspaceRole;
  if (!VALID_ROLES.includes(role))
    return Response.json({ error: "Invalid role." }, { status: 400 });

  const member = await prisma.workspaceMember.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!member) return Response.json({ error: "Member not found" }, { status: 404 });

  const denial = memberChangeError(me.role, { currentRole: member.role, nextRole: role });
  if (denial) return forbidden(denial);

  if (
    member.role === "owner" &&
    member.userId &&
    role !== "owner" &&
    (await activeOwnerCount(workspace.id)) <= 1
  )
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
  const me = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!me) return forbidden("Member management requires the admin role.");

  const { id } = await params;
  const member = await prisma.workspaceMember.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!member) return Response.json({ error: "Member not found" }, { status: 404 });

  const denial = memberChangeError(me.role, { currentRole: member.role });
  if (denial) return forbidden(denial);

  if (member.role === "owner" && member.userId && (await activeOwnerCount(workspace.id)) <= 1)
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
  // Phase 15.3 (pricing): one seat fewer can lower the Stripe extra-seat
  // quantity (paying less needs no confirmation). Never fails the removal.
  const seatSync = await syncSeatsBestEffort(workspace.id);
  return Response.json({
    ok: true,
    ...(seatSync.skipped ? {} : { seatSync: { ok: seatSync.ok, quantity: seatSync.result?.quantity ?? null, error: seatSync.error ?? null } }),
  });
}
