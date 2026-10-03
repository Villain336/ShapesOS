// Marketr — regenerate a pending member's invite link (day-1 hardening, M5).
// POST /api/workspace/members/[id]/invite-link → { ok, inviteUrl } (admin+)
//
// Mints a fresh single-use token (invalidating the previous link) so an
// admin can re-share an invite without deleting and re-creating the row.
// Only pending members (userId null) have invite links.
// Phase 3: POST with { email: true } also emails the fresh link to the
// invitee when the deployment has mail set up.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { mintInviteToken, requireWorkspaceRole, forbidden, memberChangeError } from "@/lib/authz";
import { sendInviteEmail } from "@/lib/workspace/invite-mail";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
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
  const inviteUrl = `/invite?token=${inviteToken}`;
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  if (body?.email === true && member.email) {
    const mail = await sendInviteEmail({
      to: member.email,
      workspaceName: workspace.name,
      inviterName: user.name || user.email || "A teammate",
      role: member.role,
      inviteUrl,
      expiresAt: inviteExpiresAt,
      requestOrigin: new URL(req.url).origin,
    });
    return Response.json({
      ok: true,
      inviteUrl,
      emailed: mail.sent,
      ...(mail.sent ? {} : { emailNote: mail.message }),
    });
  }
  return Response.json({ ok: true, inviteUrl });
}
