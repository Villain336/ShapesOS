// Marketr — session + workspace helpers.
// Milestone 11: workspace resolution is membership-aware (RBAC). A signed-in
// user resolves to:
//   1. their SSO-provisioned workspace (if SSO auto-provisioning ran), else
//   2. the first workspace they own or are a member of, else
//   3. a freshly created personal workspace (with an `owner` membership row).
// Multi-workspace switching UI is a follow-up; the resolver picks the most
// recently created accessible workspace deterministically.

import { auth } from "@/auth";
import { prisma } from "./prisma";

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session.user;
}

/** All workspaces the user can access (owned or member), newest first. */
export async function getAccessibleWorkspaces(userId: string) {
  return prisma.workspace.findMany({
    where: {
      OR: [{ ownerUserId: userId }, { members: { some: { userId } } }],
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getOrCreateWorkspace(
  userId: string,
  email?: string | null,
) {
  // NOTE (day-1 hardening, M5): pending invites are claimed via their
  // single-use token link (/invite?token=…), never by bare email match —
  // so no auto-linking happens here anymore.
  const accessible = await getAccessibleWorkspaces(userId);
  // Prefer a workspace where the user is an explicit member (e.g. SSO
  // auto-provisioning) over a legacy owner-only workspace.
  const memberOf = await prisma.workspaceMember.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { workspaceId: true },
  });
  if (memberOf) {
    const ws = accessible.find((w) => w.id === memberOf.workspaceId);
    if (ws) return ws;
  }
  const existing = accessible[0];
  if (existing) return existing;

  const created = await prisma.workspace.create({
    data: {
      name: email ? `${email}'s workspace` : "My workspace",
      ownerUserId: userId,
      plan: "self_hosted",
      members: { create: { userId, role: "owner" } },
    },
  });
  return created;
}
