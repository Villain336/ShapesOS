// ShapesOS — POST /api/auth/email/signup { email, password, name, captchaToken? }
// (Phase 6). Public by design: it is the first step of a sign-up, like the
// Auth.js endpoints beside it, and grants nothing by itself — it creates an
// UNVERIFIED account and emails a single-use verification link; a password
// only works once that link is used. The answer is the same 202 whether or
// not the address already has an account (no enumeration).
// Guards (lib/auth/email/store.ts signUpWithEmail): SIGNUP_MODE=invite
// (signInAllowed — the same check as the Auth.js signIn callback), the login
// lockout, CAPTCHA when a provider is configured, the password policy, a
// per-address send limit, and the proxy's auth tier (10/min per IP).

import { errorResponse } from "@/lib/api/errors";
import { emailAuthRequestContext, readEmailAuthBody } from "@/lib/auth/email/http";
import { signUpWithEmail } from "@/lib/auth/email/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await readEmailAuthBody(req);
    const { ip, deps } = emailAuthRequestContext(req);
    const res = await signUpWithEmail(
      { email: body.email, password: body.password, name: body.name, ip, captchaToken: body.captchaToken },
      deps,
    );
    return Response.json(res, { status: 202 });
  } catch (err) {
    return errorResponse(err, "POST /api/auth/email/signup", req);
  }
}
