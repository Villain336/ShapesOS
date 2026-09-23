// Marketr — MCP API key revocation (Phase C, W5). Admin+ only.
//
// DELETE /api/mcp/keys/[id] → revokes the key (revokedAt set; the row is kept
// for audit). Idempotent.

import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) return forbidden();

  const { id } = await params;
  const key = await prisma.mcpApiKey.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!key) return Response.json({ error: "not found" }, { status: 404 });
  if (!key.revokedAt) {
    await prisma.mcpApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    await prisma.fileChangeLog
      .create({
        data: {
          projectId: null,
          workspaceId: workspace.id,
          filePath: "mcp:mcp_key_revoked",
          actor: "user",
          action: "mcp_key_revoked",
          summary: `[mcp] api key revoked name="${key.name}" keyId=${key.id}`.slice(0, 500),
          approvedBy: user.id,
        },
      })
      .catch(() => {});
  }
  return Response.json({ revoked: true });
}
