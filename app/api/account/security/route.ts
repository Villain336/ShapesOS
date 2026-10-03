// ShapesOS — your account's security (Phase 4a).
// GET /api/account/security → { totp, recoveryCodesRemaining, passkeys, requiredBy, session }
// Self-service: requireAccountUser (lib/auth/mfa/guard.ts) — only the caller's own factors.

import { errorResponse } from "@/lib/api/errors";
import { requireAccountUser } from "@/lib/auth/mfa/guard";
import { accountSecurityView } from "@/lib/auth/mfa/account";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireAccountUser();
    const view = await accountSecurityView(user.id);
    return Response.json({ ...view, session: { twoFactor: user.twoFactor, mfaAt: user.mfaAt } });
  } catch (err) {
    return errorResponse(err, "GET /api/account/security");
  }
}
