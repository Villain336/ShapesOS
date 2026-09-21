// Marketr — SSO domain-based auto-provisioning (milestone 11).
//
// When SSO_WORKSPACE_ID + SSO_DOMAIN are set, a user signing in via the OIDC
// or SAML provider whose email domain matches SSO_DOMAIN is added to that
// workspace with SSO_DEFAULT_ROLE (default "editor") instead of getting a
// personal workspace. Pending email invites (added via the Members page) are
// linked on every sign-in regardless of provider.

import { prisma } from "./prisma";
import { linkPendingInvites } from "./authz";
import type { WorkspaceRole } from "@prisma/client";

const VALID_ROLES: WorkspaceRole[] = ["owner", "admin", "editor", "viewer"];

export function ssoAutoProvisioningConfigured(): boolean {
  return Boolean(
    (process.env.SSO_WORKSPACE_ID ?? "").trim() &&
      (process.env.SSO_DOMAIN ?? "").trim(),
  );
}

function defaultSsoRole(): WorkspaceRole {
  const r = (process.env.SSO_DEFAULT_ROLE ?? "editor").trim().toLowerCase();
  return (VALID_ROLES as string[]).includes(r) ? (r as WorkspaceRole) : "editor";
}

export async function provisionSsoUser(userId: string, email: string) {
  const normalized = email.trim().toLowerCase();
  await linkPendingInvites(userId, normalized);

  if (!ssoAutoProvisioningConfigured()) return;
  const domain = (process.env.SSO_DOMAIN ?? "").trim().toLowerCase();
  const workspaceId = (process.env.SSO_WORKSPACE_ID ?? "").trim();
  if (!normalized.endsWith(`@${domain}`)) return;

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return;

  const existing = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
  });
  if (existing) return;

  // Claim a pending invite if one exists, otherwise create the membership.
  const pending = await prisma.workspaceMember.findFirst({
    where: { workspaceId, email: normalized, userId: null },
  });
  if (pending) {
    await prisma.workspaceMember.update({
      where: { id: pending.id },
      data: { userId },
    });
    return;
  }
  await prisma.workspaceMember.create({
    data: {
      workspaceId,
      userId,
      email: normalized,
      role: defaultSsoRole(),
    },
  });
}
