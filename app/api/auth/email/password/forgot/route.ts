// ShapesOS — POST /api/auth/email/password/forgot { email, captchaToken? }
// (Phase 6). Public by design. Always answers 200 with the same body; a
// single-use 1-hour reset link goes out only when the address has an email
// account. Grants nothing by itself (see ../reset).
// Guards (lib/auth/email/store.ts requestPasswordReset): login lockout,
// CAPTCHA step-up, per-address send limit, proxy auth tier (10/min per IP).

import { errorResponse } from "@/lib/api/errors";
import { emailAuthRequestContext, readEmailAuthBody } from "@/lib/auth/email/http";
import { requestPasswordReset } from "@/lib/auth/email/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await readEmailAuthBody(req);
    const { ip, deps } = emailAuthRequestContext(req);
    return Response.json(await requestPasswordReset({ email: body.email, ip, captchaToken: body.captchaToken }, deps));
  } catch (err) {
    return errorResponse(err, "POST /api/auth/email/password/forgot", req);
  }
}
