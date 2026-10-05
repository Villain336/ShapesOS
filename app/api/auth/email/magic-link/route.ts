// ShapesOS — POST /api/auth/email/magic-link { email, captchaToken? } (Phase 6).
// Public by design (first half of a sign-in). Always answers 200 with the
// same body: a single-use 15-minute sign-in link goes out when the address
// has an account — or, under open signup (or with a pending invite), a link
// that creates the account on first use. Grants nothing by itself: the link
// is redeemed through the "email-link" Credentials provider (auth.ts).
// Guards (lib/auth/email/store.ts requestMagicLink): login lockout, CAPTCHA
// step-up, per-address send limit, proxy auth tier (10/min per IP).

import { errorResponse } from "@/lib/api/errors";
import { emailAuthRequestContext, readEmailAuthBody } from "@/lib/auth/email/http";
import { requestMagicLink } from "@/lib/auth/email/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await readEmailAuthBody(req);
    const { ip, deps } = emailAuthRequestContext(req);
    return Response.json(await requestMagicLink({ email: body.email, ip, captchaToken: body.captchaToken }, deps));
  } catch (err) {
    return errorResponse(err, "POST /api/auth/email/magic-link", req);
  }
}
