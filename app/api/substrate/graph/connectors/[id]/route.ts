// Marketr — Phase 8 G1: connector revoke API.
// DELETE /api/substrate/graph/connectors/:id?workspaceId=
// Revoke stops sync and webhook ingest; history (facts/nodes/edges) is KEPT.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, notFound } from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "editor");
  if ("error" in access) return access.error;
  const { id } = await ctx.params;

  const updated = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.graphConnector.updateMany({
      where: { workspaceId: access.workspaceId, id },
      data: { status: "revoked" },
    }),
  );
  if (updated.count === 0) return notFound("Connector not found");

  // Kill any scheduled jobs for this connector — revoked means stopped.
  await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.graphSyncJob.updateMany({
      where: { workspaceId: access.workspaceId, connectorId: id },
      data: { status: "dead" },
    }),
  );

  await auditEvent({
    projectId: null,
    workspaceId: access.workspaceId,
    action: "graph_connector_changed",
    summary: `graph connector revoked (${id}) — sync stopped, history kept`,
    actor: "user",
    actorUserId: user.id,
  }).catch(() => {});
  return Response.json({ revoked: true });
}
