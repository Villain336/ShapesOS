// ShapesOS — workspace security policy: require two-factor auth (Phase 4a).
//
// GET → { requireTwoFactor, members: { total, withoutTwoFactor } } (admin+)
// PUT { requireTwoFactor } → owner only. Turning it on also requires the
//     owner's own session to have passed a second factor (so they can't lock
//     themselves out, and a stolen password alone can't flip it).
// Enforced at the session guard (lib/authz.ts getMembership) with a setup
// redirect in the dashboard shell (lib/auth/mfa/policy.ts). Audited.

import { ConflictError, ForbiddenError, errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

async function memberCoverage(workspaceId: string) {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, userId: { not: null } },
    select: { userId: true },
  });
  const ids = members.map((m) => m.userId!) as string[];
  if (!ids.length) return { total: 0, withoutTwoFactor: 0 };
  const [totp, passkeys] = await Promise.all([
    prisma.userSecurity.findMany({ where: { userId: { in: ids }, totpEnabledAt: { not: null } }, select: { userId: true } }),
    prisma.userPasskey.findMany({ where: { userId: { in: ids } }, select: { userId: true }, distinct: ["userId"] }),
  ]);
  const covered = new Set([...totp.map((t) => t.userId), ...passkeys.map((p) => p.userId)]);
  return { total: ids.length, withoutTwoFactor: ids.filter((id) => !covered.has(id)).length };
}

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
    if (!membership) throw new ForbiddenError("Only admins and owners can see the security policy.");
    return Response.json({
      workspaceId: workspace.id,
      requireTwoFactor: workspace.requireTwoFactor,
      canEdit: membership.role === "owner",
      members: await memberCoverage(workspace.id),
    });
  } catch (err) {
    return errorResponse(err, "GET /api/settings/security/policy");
  }
}

const Schema = z.object({ requireTwoFactor: z.boolean() });

export async function PUT(req: Request) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const membership = await requireWorkspaceRole(user.id, workspace.id, "owner");
    if (!membership) throw new ForbiddenError("Only owners can change the security policy.");
    const v = validateBody(Schema, await readJsonBody(req));
    if (!v.ok) return v.error;
    if (v.data.requireTwoFactor && !user.twoFactor) {
      throw new ConflictError("Set up two-factor authentication for your own account (and sign in with it) first.");
    }
    if (v.data.requireTwoFactor !== workspace.requireTwoFactor) {
      await prisma.workspace.update({ where: { id: workspace.id }, data: { requireTwoFactor: v.data.requireTwoFactor } });
      await auditEvent({
        projectId: null,
        workspaceId: workspace.id,
        action: "security_policy_updated",
        summary: `two-factor requirement turned ${v.data.requireTwoFactor ? "on" : "off"}`,
        actorUserId: user.id,
      });
    }
    return Response.json({ requireTwoFactor: v.data.requireTwoFactor });
  } catch (err) {
    return errorResponse(err, "PUT /api/settings/security/policy");
  }
}
