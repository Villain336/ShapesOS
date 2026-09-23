// Marketr — revoke an OAuth client, Phase C W5.
//
// DELETE /api/mcp/oauth/clients/[id]
// Owner-only. Deletes the client, its codes, and its tokens — all outstanding
// tokens die immediately because lookup is by stored hash.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId: id } });
  // Indistinguishable 404: never confirm a client exists to an unauthorized caller.
  if (!client) return Response.json({ error: "not found" }, { status: 404 });
  // Authorized: the client owner, or an admin of the workspace it is bound to.
  const isOwner = client.userId !== null && client.userId === user.id;
  let isWsAdmin = false;
  if (client.workspaceId) {
    const membership = await requireWorkspaceRole(user.id, client.workspaceId, "admin");
    isWsAdmin = !!membership;
  }
  if (!isOwner && !isWsAdmin) return forbidden();
  await prisma.mcpOAuthToken.deleteMany({ where: { clientId: id } });
  await prisma.mcpOAuthCode.deleteMany({ where: { clientId: id } });
  await prisma.mcpOAuthClient.delete({ where: { clientId: id } });
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId: client.workspaceId ?? "unbound",
        filePath: "mcp:mcp_oauth_authorized",
        actor: "user",
        action: "mcp_oauth_revoked",
        summary: `[mcp] oauth client revoked client=${id}`.slice(0, 500),
        approvedBy: user.id,
      },
    })
    .catch(() => {});
  return Response.json({ ok: true });
}
