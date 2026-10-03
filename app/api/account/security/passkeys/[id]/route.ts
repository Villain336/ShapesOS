// ShapesOS — rename or remove one of your passkeys (Phase 4a).
// PATCH  { name } → rename
// DELETE { code? } → remove; needs re-auth (a fresh code, or a second factor
//        — e.g. a passkey check — in the last 10 minutes). Refused when it
//        would leave no factor while a workspace requires 2FA.
// Self-service: requireAccountUser — the passkey must belong to the caller
// (another user's id is a 404).

import { ConflictError, NotFoundError, errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import { prisma } from "@/lib/prisma";
import { requireAccountUser, requireReauth } from "@/lib/auth/mfa/guard";
import { auditSecurity, factorSummary } from "@/lib/auth/mfa/store";
import { wouldBreakPolicy } from "@/lib/auth/mfa/account";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const RenameSchema = z.object({ name: z.string().trim().min(1, "Name the passkey").max(60) });

export async function PATCH(req: Request, { params }: Params) {
  try {
    const user = await requireAccountUser();
    const { id } = await params;
    const v = validateBody(RenameSchema, await readJsonBody(req));
    if (!v.ok) return v.error;
    const res = await prisma.userPasskey.updateMany({ where: { id, userId: user.id }, data: { name: v.data.name } });
    if (res.count !== 1) throw new NotFoundError("Passkey not found.");
    return Response.json({ id, name: v.data.name });
  } catch (err) {
    return errorResponse(err, "PATCH /api/account/security/passkeys/[id]");
  }
}

const DeleteSchema = z.object({ code: z.string().trim().max(64).optional() });

export async function DELETE(req: Request, { params }: Params) {
  try {
    const user = await requireAccountUser();
    const { id } = await params;
    const v = validateBody(DeleteSchema, (await readJsonBody(req)) ?? {});
    if (!v.ok) return v.error;
    const passkey = await prisma.userPasskey.findFirst({ where: { id, userId: user.id }, select: { id: true, name: true } });
    if (!passkey) throw new NotFoundError("Passkey not found.");
    const summary = await factorSummary(user.id);
    const blocked = await wouldBreakPolicy(user.id, { totp: summary.totp, passkeys: summary.passkeys - 1 });
    if (blocked) throw new ConflictError(blocked);
    await requireReauth(user, req, v.data.code);
    await prisma.userPasskey.deleteMany({ where: { id: passkey.id, userId: user.id } });
    await auditSecurity(user.id, "security_passkey_removed", `passkey "${passkey.name}" removed for ${user.email ?? user.id}`);
    return Response.json({ removed: true });
  } catch (err) {
    return errorResponse(err, "DELETE /api/account/security/passkeys/[id]");
  }
}
