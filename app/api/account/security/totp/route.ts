// ShapesOS — authenticator-app (TOTP) two-factor for your account (Phase 4a).
//
// POST   → start enrollment: { secret, otpauthUri, qr } (secret shown once;
//          stored sealed with the credential envelope)
// PUT    { code } → confirm: TOTP on, 10 recovery codes (shown once) and a
//          single-use proof that upgrades THIS session to "second factor
//          passed" (the client redeems it via signIn("two-factor", { proof }))
// DELETE { code? } → disable: needs re-auth (a fresh code, or a second factor
//          in the last 10 minutes); refused if it would leave no factor while
//          a workspace requires 2FA.
// Self-service: requireAccountUser — the caller's own account only.

import { BadRequestError, ConflictError, errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import { clientIpFromHeaders } from "@/lib/api/client-ip";
import { loginLockedOut, recordLoginFailure, recordLoginSuccess } from "@/lib/auth/rate-limit";
import { requireAccountUser, requireReauth } from "@/lib/auth/mfa/guard";
import { auditSecurity, confirmTotpEnrollment, disableTotp, factorSummary, startTotpEnrollment } from "@/lib/auth/mfa/store";
import { otpauthQrDataUrl, wouldBreakPolicy } from "@/lib/auth/mfa/account";
import { mintMfaProof } from "@/lib/auth/mfa/challenge";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await requireAccountUser();
    const summary = await factorSummary(user.id);
    if (summary.totp) throw new ConflictError("Authenticator app is already set up. Turn it off first to replace it.");
    const { secret, uri } = await startTotpEnrollment(user.id, { email: user.email, name: user.name });
    return Response.json({ secret, otpauthUri: uri, qr: await otpauthQrDataUrl(uri) });
  } catch (err) {
    return errorResponse(err, "POST /api/account/security/totp");
  }
}

const ConfirmSchema = z.object({ code: z.string().trim().min(6).max(12) });

export async function PUT(req: Request) {
  try {
    const user = await requireAccountUser();
    const v = validateBody(ConfirmSchema, await readJsonBody(req));
    if (!v.ok) return v.error;
    const ip = clientIpFromHeaders(req.headers);
    const key = `2fa:${user.id}`;
    if (loginLockedOut(ip, key)) return Response.json({ error: "Too many wrong codes. Wait a while and try again." }, { status: 429 });
    const result = await confirmTotpEnrollment(user.id, v.data.code);
    if (!result.ok) {
      if (result.reason === "invalid") {
        recordLoginFailure(ip, key);
        throw new BadRequestError("That code didn't match. Check the time on your phone and enter the newest code.", { code: "invalid_code" });
      }
      throw new BadRequestError(
        result.reason === "expired" ? "Setup timed out. Start again to get a new key." : "Start setup first.",
        { code: result.reason },
      );
    }
    recordLoginSuccess(ip, key);
    await auditSecurity(user.id, "security_2fa_enabled", `authenticator app enabled for ${user.email ?? user.id}`);
    const proof = await mintMfaProof(user.id, "otp");
    return Response.json({ enabled: true, recoveryCodes: result.recoveryCodes, proof });
  } catch (err) {
    return errorResponse(err, "PUT /api/account/security/totp");
  }
}

const DisableSchema = z.object({ code: z.string().trim().max(64).optional() });

export async function DELETE(req: Request) {
  try {
    const user = await requireAccountUser();
    const v = validateBody(DisableSchema, (await readJsonBody(req)) ?? {});
    if (!v.ok) return v.error;
    const summary = await factorSummary(user.id);
    if (!summary.totp) return Response.json({ disabled: true });
    const blocked = await wouldBreakPolicy(user.id, { totp: false, passkeys: summary.passkeys });
    if (blocked) throw new ConflictError(blocked);
    await requireReauth(user, req, v.data.code);
    await disableTotp(user.id);
    await auditSecurity(user.id, "security_2fa_disabled", `authenticator app disabled for ${user.email ?? user.id}`);
    return Response.json({ disabled: true });
  } catch (err) {
    return errorResponse(err, "DELETE /api/account/security/totp");
  }
}
