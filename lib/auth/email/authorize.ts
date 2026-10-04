// ShapesOS — Auth.js Credentials providers for email accounts (Phase 6).
//
//   "email-password"  email + password. Same guards as the env-admin login:
//                     the shared lockout (lib/auth/rate-limit.ts, per IP and
//                     per address), the CAPTCHA step-up (lib/auth/captcha.ts)
//                     before the password is compared, and auth audit events.
//                     Unverified addresses can't sign in with a password.
//   "email-link"      a one-time verify / magic-link token from an email.
//                     Auth.js's own email provider needs a database adapter;
//                     this keeps sign-in stateless JWT.
//
// Both return the stable subject "email:<address>". Everything after that is
// the existing post-sign-in flow in auth.ts: the invite-only gate (signIn
// callback), the TOTP/passkey pending session and the workspace 2FA policy
// (jwt callback → applySignIn), trial provisioning on first workspace load,
// and the account-deletion cutoff (session authAt vs account_deleted_at).

import { CredentialsSignin, type User } from "next-auth";
import { prisma } from "@/lib/prisma";
import { clientIpFromHeaders } from "@/lib/api/client-ip";
import { loginLockedOutAsync, recordLoginFailureAsync, recordLoginSuccessAsync } from "@/lib/auth/rate-limit";
import { captchaRequiredAsync, verifyCaptchaToken } from "@/lib/auth/captcha";
import { normalizeEmail } from "./tokens";
import { checkEmailPassword, consumeSignInLink } from "./store";

export class EmailCaptchaRequiredError extends CredentialsSignin {
  code = "captcha_required";
}

export class EmailLockedError extends CredentialsSignin {
  code = "locked";
}

/** Right password, but the address isn't verified yet. */
export class EmailUnverifiedError extends CredentialsSignin {
  code = "email_unverified";
}

/** The link is unknown, used or expired. */
export class EmailLinkInvalidError extends CredentialsSignin {
  code = "link_invalid";
}

/** SIGNUP_MODE=invite and the address has no membership or pending invite. */
export class EmailInviteRequiredError extends CredentialsSignin {
  code = "invite_required";
}

/**
 * Lockout "account" key for link attempts. The token names no account up
 * front, so it is per IP: one shared key would let anyone lock every
 * magic-link sign-in at once with five junk tokens.
 */
function linkKey(ip: string | null): string {
  return `email-link:${ip ?? "no-ip"}`;
}

async function audit(action: "auth_login_failed" | "auth_login_succeeded", summary: string): Promise<void> {
  await prisma.fileChangeLog
    .create({ data: { projectId: null, workspaceId: null, filePath: "(auth)", actor: "system", action, summary: summary.slice(0, 500) } })
    .catch((err: unknown) => console.error("[auth] audit write failed:", (err as { code?: string })?.code ?? err));
}

export async function authorizeEmailPassword(
  credentials: Partial<Record<string, unknown>>,
  request: Request | undefined,
): Promise<User | null> {
  const email = normalizeEmail(credentials?.email) ?? "";
  const password = typeof credentials?.password === "string" ? credentials.password : "";
  const ip = clientIpFromHeaders(request?.headers);
  const key = email || "unknown";

  // Fail closed under lockout: don't even compare the password.
  if (await loginLockedOutAsync(ip, key)) {
    console.warn(`[auth] email login blocked (rate limit): ${key} from ${ip ?? "unknown ip"}`);
    throw new EmailLockedError();
  }
  if (await captchaRequiredAsync(ip, key)) {
    const token = typeof credentials?.captchaToken === "string" ? credentials.captchaToken : "";
    if (!(await verifyCaptchaToken(token, ip))) throw new EmailCaptchaRequiredError();
  }
  if (!email || !password) {
    await recordLoginFailureAsync(ip, key);
    return null;
  }
  const result = await checkEmailPassword(email, password);
  if (result.status === "invalid") {
    await recordLoginFailureAsync(ip, email);
    await audit("auth_login_failed", `email login failed for ${email} from ${ip ?? "unknown ip"}`);
    return null;
  }
  if (result.status === "unverified") {
    // Only reachable with the right password, so it reveals nothing new.
    await audit("auth_login_failed", `email login refused for ${email} (address not verified) from ${ip ?? "unknown ip"}`);
    throw new EmailUnverifiedError();
  }
  await recordLoginSuccessAsync(ip, email);
  await audit("auth_login_succeeded", `email login succeeded for ${email} from ${ip ?? "unknown ip"}`);
  return { id: result.account.userId, email: result.account.email, name: result.account.name ?? result.account.email };
}

export async function authorizeEmailLink(
  credentials: Partial<Record<string, unknown>>,
  request: Request | undefined,
): Promise<User | null> {
  const ip = clientIpFromHeaders(request?.headers);
  const key = linkKey(ip);
  if (await loginLockedOutAsync(ip, key)) throw new EmailLockedError();
  const result = await consumeSignInLink(credentials?.token);
  if (result.status !== "ok") {
    await recordLoginFailureAsync(ip, key);
    await audit("auth_login_failed", `email link sign-in ${result.status === "refused" ? "refused (invite required)" : "failed (invalid or used link)"} from ${ip ?? "unknown ip"}`);
    if (result.status === "invalid") throw new EmailLinkInvalidError();
    throw new EmailInviteRequiredError();
  }
  await recordLoginSuccessAsync(ip, key);
  await recordLoginSuccessAsync(ip, result.account.email);
  await audit("auth_login_succeeded", `email link sign-in for ${result.account.email} from ${ip ?? "unknown ip"}`);
  return { id: result.account.userId, email: result.account.email, name: result.account.name ?? result.account.email };
}
