// Marketr — workspace members API (milestone 11: RBAC; day-1 hardening M5).
// GET  /api/workspace/members            → { members, myRole } (any member)
// POST /api/workspace/members { email, role } → invite (admin+; never above
//   the inviter's own role, so only owners invite owners). Creates a
//   pending membership with a single-use token; the invitee claims it via the
//   token link at /invite?token=… (see app/api/workspace/invites/accept).
// All mutations are audit-logged (workspace-scoped).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import {
  getMembership,
  mintInviteToken,
  requireWorkspaceRole,
  forbidden,
  memberChangeError,
} from "@/lib/authz";
import { readJsonBody } from "@/lib/sitefiles/api";
import type { WorkspaceRole } from "@prisma/client";

const VALID_ROLES: WorkspaceRole[] = ["owner", "admin", "editor", "viewer"];

function publicMember(m: {
  id: string;
  email: string | null;
  name: string | null;
  role: WorkspaceRole;
  userId: string | null;
  createdAt: Date;
}) {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    role: m.role,
    pending: m.userId === null,
    createdAt: m.createdAt.toISOString(),
  };
}

async function audit(
  workspaceId: string,
  actor: string,
  action: "member_added",
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

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) return Response.json({ error: "Forbidden" }, { status: 403 });

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
  });
  return Response.json({
    workspace: { id: workspace.id, name: workspace.name },
    myRole: me.role,
    members: members.map(publicMember),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!me) return forbidden("Member management requires the admin role.");

  const body = await readJsonBody<{ email?: string; role?: string }>(req);
  const email = (body?.email ?? "").trim().toLowerCase();
  const role = (body?.role ?? "viewer").trim().toLowerCase() as WorkspaceRole;
  if (!email || !email.includes("@"))
    return Response.json({ error: "A valid email is required." }, { status: 400 });
  if (!VALID_ROLES.includes(role))
    return Response.json({ error: "Invalid role." }, { status: 400 });
  // Phase 1: no inviting above your own role (admins can't invite owners).
  const denial = memberChangeError(me.role, { nextRole: role });
  if (denial) return forbidden(denial);

  const existing = await prisma.workspaceMember.findFirst({
    where: { workspaceId: workspace.id, email },
  });
  if (existing)
    return Response.json({ error: "That email is already a member." }, { status: 409 });

  const member = await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, email, role, ...mintInviteToken() },
  });
  await audit(
    workspace.id,
    user.id,
    "member_added",
    `${user.email ?? user.id} invited ${email} as ${role}`,
  );
  // Day-1 hardening (M5): invites are claimed via a single-use token link,
  // never by bare email match. Share this link with the invitee directly.
  const inviteUrl = `/invite?token=${member.inviteToken}`;
  return Response.json({ ok: true, member: publicMember(member), inviteUrl });
}
