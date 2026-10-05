// ShapesOS — passkey re-auth options (Phase 4a).
// POST → { challengeId, options } limited to the caller's own passkeys. The
// client signs with one and finishes via signIn("passkey", …), which refreshes
// this session's second-factor time (the re-auth window for sensitive changes).
// Self-service: requireAccountUser — the challenge is bound to the caller, so
// it can't be completed with someone else's passkey.

import { ConflictError, errorResponse } from "@/lib/api/errors";
import { requireAccountUser } from "@/lib/auth/mfa/guard";
import { passkeyAuthenticationOptions } from "@/lib/auth/mfa/webauthn";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await requireAccountUser();
    const count = await prisma.userPasskey.count({ where: { userId: user.id } });
    if (!count) throw new ConflictError("You have no passkeys yet.");
    return Response.json(await passkeyAuthenticationOptions(user.id));
  } catch (err) {
    return errorResponse(err, "POST /api/account/security/passkeys/reauth-options");
  }
}
