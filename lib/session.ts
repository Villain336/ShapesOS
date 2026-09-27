// Marketr — session + workspace helpers.
// Milestone 11: workspace resolution is membership-aware (RBAC). A signed-in
// user resolves to:
//   0. their explicitly chosen workspace (the marketr_active_workspace
//      cookie set by POST /api/workspaces/active), when it names a workspace
//      they can still access, else
//   1. their SSO-provisioned workspace (if SSO auto-provisioning ran), else
//   2. the first workspace they own or are a member of, else
//   3. a freshly created personal workspace (with an `owner` membership row).
//
// The cookie preference is honored inside getOrCreateWorkspace so the switch
// propagates to every page and API route that resolves "the current
// workspace". Every route still enforces its own RBAC per workspace — the
// cookie is a preference, not a capability.

import { auth } from "@/auth";
import { prisma } from "./prisma";

/** httpOnly preference cookie naming the user's active workspace. */
export const ACTIVE_WORKSPACE_COOKIE = "marketr_active_workspace";

/** Read the active-workspace cookie; null outside a request scope or unset. */
async function activeWorkspaceIdFromCookie(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    const value = store.get(ACTIVE_WORKSPACE_COOKIE)?.value?.trim();
    return value || null;
  } catch {
    // Non-request contexts (tests, cron helpers) have no cookie jar.
    return null;
  }
}

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
  // Phase 13 Wave A (white-label ops): the user's explicit workspace choice
  // wins over the deterministic fallbacks below. The id is re-validated
  // against the accessible set — a stale or forged cookie can only ever
  // resolve to a workspace the user already belongs to.
  const preferred = await activeWorkspaceIdFromCookie();
  if (preferred) {
    const chosen = accessible.find((w) => w.id === preferred);
    if (chosen) return chosen;
  }
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
