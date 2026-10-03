// ShapesOS — who may sign up (Phase 1: SIGNUP_MODE).
//
//   SIGNUP_MODE=open (default)  any Google/OIDC/SAML sign-in without a
//                               workspace gets a personal one provisioned.
//   SIGNUP_MODE=invite          brand-new users are NOT auto-provisioned.
//                               Sign-in is allowed only for:
//                                 - the ADMIN_EMAIL credentials login (the
//                                   operator, who seeds the first workspace);
//                                 - users who already belong to a workspace
//                                   (incl. SSO domain auto-provisioning,
//                                   which runs first);
//                                 - users holding a pending, unexpired invite
//                                   addressed to their email (they then claim
//                                   it via the /invite?token=… link).
//                               Everyone else lands on /invite-required.
//
// Enforced twice: the Auth.js signIn callback refuses the session, and
// getOrCreateWorkspace refuses to create a workspace (InviteRequiredError)
// for anyone who isn't the operator — e.g. an invitee who signed in but
// hasn't opened their invite link yet.

import { prisma } from "@/lib/prisma";

export type SignupMode = "open" | "invite";

export function signupMode(env: NodeJS.ProcessEnv = process.env): SignupMode {
  return (env.SIGNUP_MODE ?? "").trim().toLowerCase() === "invite" ? "invite" : "open";
}

/** Thrown by getOrCreateWorkspace in invite mode instead of provisioning. */
export class InviteRequiredError extends Error {
  readonly status = 403;
  constructor() {
    super("An invite is required to join this ShapesOS instance.");
    this.name = "InviteRequiredError";
  }
}

export const INVITE_REQUIRED_PATH = "/invite-required";

/** The credentials-provider operator account (auth.ts mints `admin:<email>`). */
export function isOperatorUserId(userId: string): boolean {
  return userId.startsWith("admin:");
}

/** May this user get a freshly created personal workspace? */
export function mayProvisionWorkspace(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return signupMode(env) === "open" || isOperatorUserId(userId);
}

/** May this user sign in at all? (Only restricts anything in invite mode.) */
export async function signInAllowed(
  userId: string | null | undefined,
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (signupMode(env) === "open") return true;
  if (userId && isOperatorUserId(userId)) return true;
  if (userId) {
    const member = await prisma.workspaceMember.findFirst({ where: { userId }, select: { id: true } });
    if (member) return true;
    const owned = await prisma.workspace.findFirst({ where: { ownerUserId: userId }, select: { id: true } });
    if (owned) return true;
  }
  const normalized = (email ?? "").trim().toLowerCase();
  if (normalized) {
    const invite = await prisma.workspaceMember.findFirst({
      where: {
        userId: null,
        email: { equals: normalized, mode: "insensitive" },
        inviteToken: { not: null },
        OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gte: new Date() } }],
      },
      select: { id: true },
    });
    if (invite) return true;
  }
  return false;
}
