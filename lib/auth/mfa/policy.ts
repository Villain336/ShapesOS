// ShapesOS — workspace "require 2FA" policy (Phase 4a).
//
// Owners can require every member to use a second factor. Enforcement:
//   - API / RBAC: lib/authz.ts getMembership() — the one place every role
//     check (requireWorkspaceRole, requireProjectRole, hasPermission,
//     requireWorkspaceAccess…) resolves a membership — returns null for a
//     signed-in session that has NOT passed a second factor, so the route
//     answers its normal 403/404. Non-session credentials (MCP keys, cron)
//     carry no browser session and are not affected; they are separately
//     scoped and revocable.
//   - Pages: the dashboard shell redirects such a session to /security/setup.
//
// "Passed a second factor" is a property of the SESSION (token.mfaAt), not of
// the account: enrolling a factor upgrades the current session through a
// single-use proof (lib/auth/mfa/challenge.ts), and every later sign-in of
// an enrolled user must pass the second step anyway.

export interface SessionMfaState {
  userId: string;
  twoFactor: boolean;
}

/**
 * The current request's session (if any) as far as the policy cares. Null
 * outside a request scope (scripts, cron helpers, tests) or without a session.
 * Imported lazily so lib/authz.ts doesn't pull Auth.js into every consumer.
 */
export async function currentSessionMfaState(): Promise<SessionMfaState | null> {
  if (testSessionState !== undefined) return testSessionState;
  try {
    const { auth } = await import("@/auth");
    const session = await auth();
    const id = session?.user?.id;
    if (!id) return null;
    return { userId: id, twoFactor: session.user.twoFactor === true };
  } catch {
    return null;
  }
}

let testSessionState: SessionMfaState | null | undefined;

/**
 * Test hook: pin what currentSessionMfaState() returns (undefined restores
 * the real Auth.js lookup). DB suites use it to drive getMembership().
 */
export function __setSessionMfaStateForTests(state: SessionMfaState | null | undefined): void {
  testSessionState = state;
}

/** Pure decision: does the policy deny this membership resolution? */
export function policyDenies(
  requireTwoFactor: boolean,
  userId: string,
  session: SessionMfaState | null,
): boolean {
  if (!requireTwoFactor) return false;
  // Only the signed-in person's own session is judged; a different or absent
  // session means a non-session credential path (MCP key, cron, script).
  if (!session || session.userId !== userId) return false;
  return !session.twoFactor;
}

/** Where the dashboard shell sends sessions the policy blocks. */
export const TWO_FACTOR_SETUP_PATH = "/security/setup";
