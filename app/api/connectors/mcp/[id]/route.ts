// Marketr — remove a workspace-custom MCP server (milestone 21).
// DELETE /api/connectors/mcp/[id]?workspaceId= → { ok }
// Removes the connector, its connections, and their credentials.
// Admin+ or connectors.connect grant. Audited (mcp_connector_removed).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "connectors.connect"))) {
    return forbidden("connectors.connect permission required.");
  }

  const connector = await prisma.connector.findFirst({
    where: { id, workspaceId },
  });
  if (!connector) return notFound("Connector not found");
  if (connector.kind !== "mcp") {
    return badRequest("Only custom MCP connectors can be removed here");
  }

  // Explicitly delete connections' credentials first (FK also cascades,
  // but explicit-first avoids orphaned rows on a racing write).
  const conns = await prisma.connectorConnection.findMany({
    where: { connectorId: id },
    select: { id: true },
  });
  const connIds = conns.map((c) => c.id);
  if (connIds.length) {
    await prisma.connectorCredential.deleteMany({ where: { connectionId: { in: connIds } } });
    await prisma.connectorConnection.deleteMany({ where: { id: { in: connIds } } });
  }
  await prisma.connector.delete({ where: { id } });

  await auditEvent({
    projectId: null,
    workspaceId,
    action: "mcp_connector_removed",
    summary: `Removed MCP connector "${connector.displayName}" (${connIds.length} connections)`,
    actorUserId: user.id,
  });
  return Response.json({ ok: true });
}

const PatchSchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  readOnlyTools: z.array(z.string().trim().min(1).max(200)).max(200),
});

/**
 * PATCH /api/connectors/mcp/[id]?workspaceId= { readOnlyTools: string[] }
 * Admin allow-list of tools the agent may run WITHOUT confirmation (H5).
 * Everything else on a custom MCP server is mutating (confirmation-gated)
 * unless the server itself annotates it readOnlyHint. Audited.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const v = validateBody(PatchSchema, await readJsonBody(req));
  if (!v.ok) return v.error;
  const workspaceId = workspaceIdFrom(req, v.data);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "connectors.connect"))) {
    return forbidden("connectors.connect permission required.");
  }
  const connector = await prisma.connector.findFirst({ where: { id, workspaceId } });
  if (!connector) return notFound("Connector not found");
  if (connector.kind !== "mcp") return badRequest("Only custom MCP connectors have a read-only allow-list");

  const readOnlyTools = [...new Set(v.data.readOnlyTools)];
  const prevConfig =
    connector.config && typeof connector.config === "object" && !Array.isArray(connector.config)
      ? (connector.config as Record<string, unknown>)
      : {};
  await prisma.connector.update({
    where: { id: connector.id },
    data: { config: { ...prevConfig, readOnlyTools } },
  });
  await auditEvent({
    projectId: null,
    workspaceId,
    action: "settings_workspace_updated",
    summary: `MCP connector "${connector.displayName}": read-only allow-list set to [${readOnlyTools.join(", ")}]`,
    actorUserId: user.id,
  });
  return Response.json({ ok: true, readOnlyTools });
}
