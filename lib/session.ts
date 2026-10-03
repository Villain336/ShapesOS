// Marketr — session + workspace helpers.
// Milestone 11: workspace resolution is membership-aware (RBAC). A signed-in
// user resolves to:
//   0. their explicitly chosen workspace (the marketr_active_workspace
//      cookie set by POST /api/workspaces/active), when it names a workspace
//      they can still access, else
//   1. their SSO-provisioned workspace (if SSO auto-provisioning ran), else
//   2. the first workspace they own or are a member of, else
//   3. a freshly created personal workspace (with an `owner` membership row)
//      — unless SIGNUP_MODE=invite, where only the operator gets one and
//      everyone else gets InviteRequiredError (lib/auth/signup.ts).
//
// The cookie preference is honored inside getOrCreateWorkspace so the switch
// propagates to every page and API route that resolves "the current
// workspace". Every route still enforces its own RBAC per workspace — the
// cookie is a preference, not a capability.

import { auth } from "@/auth";
import { prisma } from "./prisma";
import { InviteRequiredError, mayProvisionWorkspace } from "./auth/signup";
import { MAX_WORKSPACE_NAME, createWorkspaceForUser } from "./workspace/lifecycle";

/** "ana's workspace" from ana@example.com; "My workspace" without an email. */
export function defaultWorkspaceName(email?: string | null): string {
  const local = (email ?? "").split("@")[0]?.trim();
  if (!local) return "My workspace";
  return `${local.slice(0, MAX_WORKSPACE_NAME - 12)}'s workspace`;
}

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

  // Phase 1: SIGNUP_MODE=invite — only the operator gets a workspace
  // provisioned; everyone else must join through an invite.
  if (!mayProvisionWorkspace(userId)) throw new InviteRequiredError();

  // Phase 3: the plan follows DEPLOYMENT_MODE (hosted signups start the
  // 14-day trial; self-hosted keeps self_hosted) and the creation is audited.
  // The onboarding wizard lets the owner pick a real name.
  // Phase 4a: a session that outlived a deleted account must not provision a
  // fresh workspace (createWorkspaceForUser checks the sign-in time).
  // Outside a request (scripts, tests) there is no session: no sign-in time,
  // which only matters for an account that was deleted.
  let authAt: number | null = null;
  try {
    const session = await auth();
    if (session?.user?.id === userId) authAt = session.user.authAt ?? null;
  } catch {
    // no request scope
  }
  return createWorkspaceForUser({ userId, name: defaultWorkspaceName(email), ifNoneExists: true, authAt });
}
