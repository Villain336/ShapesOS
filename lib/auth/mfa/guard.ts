// ShapesOS — self-service account-security guard (Phase 4a).
//
// /api/account/security/* routes act ONLY on the caller's own factors (TOTP,
// recovery codes, passkeys), keyed by the session subject — there is no
// target id from the request that could point at someone else's account.
//
//   requireAccountUser()  a fully authenticated session (a pending second
//                         factor reads as signed out — see session-token.ts).
//   requireReauth()       for destructive changes (disable TOTP, new recovery
//                         codes, remove a passkey): a second factor passed in
//                         the last 10 minutes, or a fresh TOTP/recovery code in
//                         the request. Wrong codes count against the same
//                         "2fa:<user>" lockout as the sign-in second step.

import { auth } from "@/auth";
import { clientIpFromHeaders } from "@/lib/api/client-ip";
import { HttpError, UnauthorizedError } from "@/lib/api/errors";
import { loginLockedOutAsync, recordLoginFailureAsync, recordLoginSuccessAsync } from "@/lib/auth/rate-limit";
import { recentlyVerified } from "./session-token";
import { verifySecondFactorCode } from "./store";

export interface AccountUser {
  id: string;
  email: string | null;
  name: string | null;
  twoFactor: boolean;
  mfaAt: number | null;
}

export async function requireAccountUser(): Promise<AccountUser> {
  const session = await auth();
  const u = session?.user;
  if (!u?.id) throw new UnauthorizedError();
  return {
    id: u.id,
    email: u.email ?? null,
    name: u.name ?? null,
    twoFactor: u.twoFactor === true,
    mfaAt: typeof u.mfaAt === "number" ? u.mfaAt : null,
  };
}

/** Thrown when a sensitive change needs a fresh second factor. */
export class ReauthRequiredError extends HttpError {
  constructor(message = "Confirm it's you: enter a code from your authenticator app or a recovery code.") {
    super(401, message, { code: "reauth_required" });
    this.name = "ReauthRequiredError";
  }
}

export async function requireReauth(
  user: AccountUser,
  req: Request,
  code: string | null | undefined,
  opts: { allowRecentSession?: boolean } = {},
): Promise<"recent" | "otp" | "recovery"> {
  if (!code && opts.allowRecentSession !== false && recentlyVerified(user.mfaAt, Math.floor(Date.now() / 1000))) {
    return "recent";
  }
  if (!code) throw new ReauthRequiredError();
  const ip = clientIpFromHeaders(req.headers);
  const key = `2fa:${user.id}`;
  if (await loginLockedOutAsync(ip, key)) {
    throw new HttpError(429, "Too many wrong codes. Wait a while and try again.", { code: "locked" });
  }
  const method = await verifySecondFactorCode(user.id, code);
  if (!method) {
    await recordLoginFailureAsync(ip, key);
    throw new ReauthRequiredError("That code didn't work. Try a new code from your app, or a recovery code.");
  }
  await recordLoginSuccessAsync(ip, key);
  return method;
}
