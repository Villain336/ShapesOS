// ShapesOS — your passkeys (Phase 4a).
// GET  → { passkeys }
// POST { challengeId, response, name } → verify the registration ceremony and
//      store the passkey; returns a single-use proof that upgrades THIS
//      session to "second factor passed" (signIn("two-factor", { proof })).
// Self-service: requireAccountUser — the caller's own account only.

import { BadRequestError, ConflictError, errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import { requireAccountUser } from "@/lib/auth/mfa/guard";
import { listPasskeys } from "@/lib/auth/mfa/account";
import { auditSecurity } from "@/lib/auth/mfa/store";
import { verifyPasskeyRegistration } from "@/lib/auth/mfa/webauthn";
import { mintMfaProof } from "@/lib/auth/mfa/challenge";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireAccountUser();
    return Response.json({ passkeys: await listPasskeys(user.id) });
  } catch (err) {
    return errorResponse(err, "GET /api/account/security/passkeys");
  }
}

const Schema = z.object({
  challengeId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1, "Name the passkey").max(60),
  response: z
    .object({ id: z.string().min(1).max(1024), rawId: z.string().max(1024), type: z.literal("public-key") })
    .passthrough(),
});

export async function POST(req: Request) {
  try {
    const user = await requireAccountUser();
    const v = validateBody(Schema, await readJsonBody(req));
    if (!v.ok) return v.error;
    const result = await verifyPasskeyRegistration({
      userId: user.id,
      challengeId: v.data.challengeId,
      response: v.data.response as unknown as RegistrationResponseJSON,
      name: v.data.name,
      profile: { email: user.email, name: user.name },
    });
    if (!result.ok) {
      if (result.reason === "duplicate") throw new ConflictError("That passkey is already registered.");
      throw new BadRequestError(
        result.reason === "challenge"
          ? "The passkey request expired. Try again."
          : "Your device's response couldn't be verified. Try again.",
        { code: result.reason },
      );
    }
    await auditSecurity(user.id, "security_passkey_added", `passkey "${result.passkey.name}" added for ${user.email ?? user.id}`);
    const proof = await mintMfaProof(user.id, "passkey");
    return Response.json(
      {
        passkey: { id: result.passkey.id, name: result.passkey.name, createdAt: result.passkey.createdAt.toISOString() },
        proof,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, "POST /api/account/security/passkeys");
  }
}
