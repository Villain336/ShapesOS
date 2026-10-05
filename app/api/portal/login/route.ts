// ShapesOS — Phase 10 (portal): POST /api/portal/login { email, captchaToken? }.
// Public by design (first half of a client-portal sign-in). Always answers
// 200 with the same body: a single-use 15-minute link (SHA-256 at rest) goes
// to the address only when it is a client with the portal turned on. Grants
// nothing by itself: the link is redeemed at /portal/link (POST
// /api/portal/link) for a PORTAL session — never a workspace session.
// Guards (lib/portal/store.ts requestPortalLink): login lockout, CAPTCHA
// step-up, per-address send limit shared with workspace sign-in mail, JSON
// only + 8 KiB body cap, proxy auth tier (10/min per IP).

import { errorResponse } from "@/lib/api/errors";
import { emailAuthRequestContext, readEmailAuthBody } from "@/lib/auth/email/http";
import { requestPortalLink } from "@/lib/portal/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await readEmailAuthBody(req);
    const { ip, deps } = emailAuthRequestContext(req);
    return Response.json(await requestPortalLink({ email: body.email, ip, captchaToken: body.captchaToken }, deps));
  } catch (err) {
    return errorResponse(err, "POST /api/portal/login", req);
  }
}
