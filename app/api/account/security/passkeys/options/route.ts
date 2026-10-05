// ShapesOS — passkey registration options (Phase 4a).
// POST → { challengeId, options } for navigator.credentials.create(). The
// challenge is stored server-side, bound to the caller, single use, 5 minutes.
// Self-service: requireAccountUser — the caller's own account only.

import { ConflictError, errorResponse } from "@/lib/api/errors";
import { requireAccountUser } from "@/lib/auth/mfa/guard";
import { MAX_PASSKEYS_PER_USER, passkeyRegistrationOptions } from "@/lib/auth/mfa/webauthn";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await requireAccountUser();
    const count = await prisma.userPasskey.count({ where: { userId: user.id } });
    if (count >= MAX_PASSKEYS_PER_USER) throw new ConflictError(`You can register up to ${MAX_PASSKEYS_PER_USER} passkeys.`);
    return Response.json(await passkeyRegistrationOptions(user.id, { email: user.email, name: user.name }));
  } catch (err) {
    return errorResponse(err, "POST /api/account/security/passkeys/options");
  }
}
