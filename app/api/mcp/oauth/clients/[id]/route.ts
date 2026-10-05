// Marketr — revoke an OAuth client, Phase C W5.
//
// DELETE /api/mcp/oauth/clients/[id]
// The client's owner deletes the client, its codes, and its tokens — all
// outstanding tokens die immediately because lookup is by stored hash. An
// admin of a workspace the client holds tokens for revokes just that
// workspace's tokens/codes (Phase 1: rebinding never strands tokens).

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
  // The client owner revokes everything (client, codes, all tokens).
  const isOwner = client.userId !== null && client.userId === user.id;
  if (isOwner) {
    await prisma.mcpOAuthToken.deleteMany({ where: { clientId: id } });
    await prisma.mcpOAuthCode.deleteMany({ where: { clientId: id } });
    await prisma.mcpOAuthClient.delete({ where: { clientId: id } });
    await auditRevoke(client.workspaceId ?? "unbound", user.id, `[mcp] oauth client revoked client=${id}`);
    return Response.json({ ok: true });
  }
  // Phase 1: a client re-approved for another workspace keeps its earlier
  // tokens (each token carries its own workspaceId), so the client's CURRENT
  // binding is not the only workspace with live access. An admin of ANY
  // workspace the client holds tokens/codes for can revoke that workspace's
  // access — never another workspace's — so rebinding can't strand tokens
  // out of their admins' reach.
  const [tokenWs, codeWs] = await Promise.all([
    prisma.mcpOAuthToken.findMany({ where: { clientId: id }, select: { workspaceId: true }, distinct: ["workspaceId"] }),
    prisma.mcpOAuthCode.findMany({ where: { clientId: id }, select: { workspaceId: true }, distinct: ["workspaceId"] }),
  ]);
  const candidates = new Set<string>([...tokenWs, ...codeWs].map((r) => r.workspaceId));
  if (client.workspaceId) candidates.add(client.workspaceId);
  const adminOf: string[] = [];
  for (const ws of candidates) {
    if (await requireWorkspaceRole(user.id, ws, "admin")) adminOf.push(ws);
  }
  if (adminOf.length === 0) return forbidden();
  await prisma.mcpOAuthToken.deleteMany({ where: { clientId: id, workspaceId: { in: adminOf } } });
  await prisma.mcpOAuthCode.deleteMany({ where: { clientId: id, workspaceId: { in: adminOf } } });
  if (client.workspaceId && adminOf.includes(client.workspaceId)) {
    await prisma.mcpOAuthClient.update({ where: { clientId: id }, data: { workspaceId: null } });
  }
  for (const ws of adminOf) {
    await auditRevoke(ws, user.id, `[mcp] oauth client access revoked client=${id} workspace=${ws}`);
  }
  return Response.json({ ok: true });
}

async function auditRevoke(workspaceId: string, userId: string, summary: string) {
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId,
        filePath: "mcp:mcp_oauth_authorized",
        actor: "user",
        action: "mcp_oauth_revoked",
        summary: summary.slice(0, 500),
        approvedBy: userId,
      },
    })
    .catch(() => {});
}
