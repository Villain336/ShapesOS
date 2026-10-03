// ShapesOS — revoke a SCIM provisioning token (Phase 4a).
// DELETE → { revoked: true }; the row is kept for audit. Owner only; the
// token must belong to the current workspace (RLS-scoped lookup).

import { ForbiddenError, NotFoundError, errorResponse } from "@/lib/api/errors";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { auditEvent } from "@/lib/auditlog";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const membership = await requireWorkspaceRole(user.id, workspace.id, "owner");
    if (!membership) throw new ForbiddenError("Only owners can manage SCIM provisioning.");
    const { id } = await params;
    const token = await withWorkspaceScope(workspace.id, async (tx) => {
      const t = await tx.scimToken.findFirst({ where: { id, workspaceId: workspace.id } });
      if (!t) return null;
      if (!t.revokedAt) await tx.scimToken.update({ where: { id: t.id, workspaceId: workspace.id }, data: { revokedAt: new Date() } });
      return t;
    });
    if (!token) throw new NotFoundError("Token not found.");
    if (!token.revokedAt) {
      await auditEvent({
        projectId: null,
        workspaceId: workspace.id,
        action: "scim_token_revoked",
        summary: `SCIM token "${token.name}" revoked (${token.tokenPrefix})`,
        actorUserId: user.id,
      });
    }
    return Response.json({ revoked: true });
  } catch (err) {
    return errorResponse(err, "DELETE /api/settings/security/scim-tokens/[id]");
  }
}
