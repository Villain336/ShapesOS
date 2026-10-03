// Marketr — regenerate a pending member's invite link (day-1 hardening, M5).
// POST /api/workspace/members/[id]/invite-link → { ok, inviteUrl } (admin+)
//
// Mints a fresh single-use token (invalidating the previous link) so an
// admin can re-share an invite without deleting and re-creating the row.
// Only pending members (userId null) have invite links.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { mintInviteToken, requireWorkspaceRole, forbidden, memberChangeError } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function POST(
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
  if (member.userId)
    return Response.json({ error: "Only pending invites have invite links." }, { status: 400 });
  // Phase 1: owner invites are owner-only, including re-issuing their link.
  const denial = memberChangeError(me.role, { currentRole: member.role });
  if (denial) return forbidden(denial);

  const { inviteToken, inviteExpiresAt } = mintInviteToken();
  await prisma.workspaceMember.update({
    where: { id: member.id },
    data: { inviteToken, inviteExpiresAt },
  });
  return Response.json({ ok: true, inviteUrl: `/invite?token=${inviteToken}` });
}
