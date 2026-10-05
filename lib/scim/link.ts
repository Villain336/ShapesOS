// ShapesOS — link SCIM-provisioned members to the person at SSO sign-in
// (Phase 4a).
//
// A user created over SCIM is a pending member (userId null) because the IdP
// provisions before the person ever signs in. When they sign in through the
// SSO provider (OIDC / SAML — the IdP that also provisions) with a VERIFIED
// email, every active, not-yet-linked SCIM row with that email gets their
// subject. This is deliberately narrower than the bare-email auto-linking
// day-1 hardening removed (M5): only rows the workspace's own IdP created
// (scim_managed), only verified email claims, only the SSO providers, never
// deactivated rows, and never a second membership in the same workspace.

import { prisma } from "@/lib/prisma";

export async function linkScimMembersOnSsoLogin(
  userId: string,
  email: string | null | undefined,
  emailVerified: boolean,
): Promise<number> {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!emailVerified || !normalized || !userId) return 0;
  const rows = await prisma.workspaceMember.findMany({
    where: {
      scimManaged: true,
      userId: null,
      scimDeactivatedAt: null,
      scimSuspendedUserId: null,
      email: { equals: normalized, mode: "insensitive" },
    },
    select: { id: true, workspaceId: true },
  });
  let linked = 0;
  for (const row of rows) {
    const already = await prisma.workspaceMember.findFirst({
      where: { workspaceId: row.workspaceId, userId },
      select: { id: true },
    });
    if (already) continue;
    const res = await prisma.workspaceMember.updateMany({
      where: { id: row.id, userId: null, scimDeactivatedAt: null },
      data: { userId, inviteToken: null, inviteExpiresAt: null },
    });
    linked += res.count;
  }
  return linked;
}
