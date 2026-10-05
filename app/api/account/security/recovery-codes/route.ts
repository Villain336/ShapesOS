// ShapesOS — regenerate your recovery codes (Phase 4a).
// POST { code? } → { recoveryCodes } (shown once; every older code stops working).
// Needs re-auth (fresh code, or a second factor in the last 10 minutes).
// Self-service: requireAccountUser — the caller's own account only.

import { ConflictError, errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import { requireAccountUser, requireReauth } from "@/lib/auth/mfa/guard";
import { auditSecurity, factorSummary, regenerateRecoveryCodes } from "@/lib/auth/mfa/store";

export const dynamic = "force-dynamic";

const Schema = z.object({ code: z.string().trim().max(64).optional() });

export async function POST(req: Request) {
  try {
    const user = await requireAccountUser();
    const v = validateBody(Schema, (await readJsonBody(req)) ?? {});
    if (!v.ok) return v.error;
    const summary = await factorSummary(user.id);
    if (!summary.totp) throw new ConflictError("Set up an authenticator app first; recovery codes back it up.");
    await requireReauth(user, req, v.data.code);
    const recoveryCodes = await regenerateRecoveryCodes(user.id);
    await auditSecurity(user.id, "security_recovery_codes_regenerated", `recovery codes regenerated for ${user.email ?? user.id}`);
    return Response.json({ recoveryCodes });
  } catch (err) {
    return errorResponse(err, "POST /api/account/security/recovery-codes");
  }
}
