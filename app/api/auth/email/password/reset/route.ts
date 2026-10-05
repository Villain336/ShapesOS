// ShapesOS — POST /api/auth/email/password/reset { token, password } (Phase 6).
// Public by design: the single-use reset token from the email is the
// capability (only its SHA-256 is stored; consumed by one guarded UPDATE, so
// two concurrent uses can't both succeed). The new password must pass the
// policy before the token is spent. Success sets the password, verifies the
// address and voids every other outstanding link for it; the user then signs
// in normally (second factor included). Proxy auth tier (10/min per IP).

import { errorResponse } from "@/lib/api/errors";
import { emailAuthRequestContext, readEmailAuthBody } from "@/lib/auth/email/http";
import { resetPassword } from "@/lib/auth/email/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await readEmailAuthBody(req);
    const { ip, deps } = emailAuthRequestContext(req);
    await resetPassword({ token: body.token, password: body.password, ip }, deps);
    return Response.json({ ok: true, message: "Password changed. Sign in with your new password." });
  } catch (err) {
    return errorResponse(err, "POST /api/auth/email/password/reset", req);
  }
}
