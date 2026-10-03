// ShapesOS — passkey sign-in options (Phase 4a). Public by design: it is the
// first half of a sign-in, like the Auth.js endpoints beside it.
//
// POST → { challengeId, options } for navigator.credentials.get().
//   - With a PENDING sign-in cookie (first factor passed), the options are
//     limited to that user's passkeys and the challenge is bound to them.
//   - Otherwise usernameless: the browser offers any passkey for this site.
// The challenge is random, stored server-side, single use, 5 minutes. It
// grants nothing by itself: signIn("passkey", …) must then verify a signed
// assertion over it with a registered credential and user verification.
// Rate-limited by the proxy's auth tier (10/min per IP). Lives under
// /api/auth so it shares that tier.

import { errorResponse } from "@/lib/api/errors";
import { readSessionToken } from "@/lib/auth/mfa/token";
import { pendingSubject } from "@/lib/auth/mfa/session-token";
import { passkeyAuthenticationOptions } from "@/lib/auth/mfa/webauthn";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const token = await readSessionToken(req);
    const pending = pendingSubject(token, Math.floor(Date.now() / 1000));
    return Response.json(await passkeyAuthenticationOptions(pending));
  } catch (err) {
    return errorResponse(err, "POST /api/auth/passkey/options");
  }
}
