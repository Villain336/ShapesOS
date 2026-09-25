// Marketr — Phase 8 G1: manual sync trigger API.
// POST /api/substrate/graph/connectors/:id/sync { workspaceId }
// Human-only (editor+). Dispatches to the Tier-S runner, the WooCommerce
// gentle poller, or the CSV/onboarding helpers depending on platform.
// Sync is async work — this endpoint runs one bounded pull inline and
// reports honestly; the scheduler (Phase 9) will own the cadence.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, notFound, badRequest } from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { runScheduledPull, type TierSPlatform } from "@/lib/substrate/graph/connectors/tiers";
import { pollWooCommerce } from "@/lib/substrate/graph/connectors/tierm";
import { TIER_S } from "@/lib/substrate/graph/connectors/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { workspaceId?: string } | null;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "editor");
  if ("error" in access) return access.error;
  const { id } = await ctx.params;

  const connector = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.graphConnector.findFirst({ where: { workspaceId: access.workspaceId, id } }),
  );
  if (!connector) return notFound("Connector not found");
  if (connector.status === "revoked") {
    return badRequest("connector is revoked — re-connect before syncing");
  }

  if ((TIER_S as string[]).includes(connector.platform)) {
    const result = await runScheduledPull({
      workspaceId: access.workspaceId,
      connectorId: connector.id,
      platform: connector.platform as TierSPlatform,
      actor: `user:${user.id}`,
    });
    return Response.json(result);
  }
  if (connector.platform === "woocommerce") {
    const result = await pollWooCommerce({
      workspaceId: access.workspaceId,
      connectorId: connector.id,
    });
    return Response.json(result);
  }
  // Tier W: nothing to pull — webhooks push. Report honestly.
  return Response.json({
    ran: false,
    status: "idle",
    rowsIngested: 0,
    opsUsed: 0,
    detail: `${connector.platform} is webhook-tier: data arrives via push, there is nothing to pull`,
  });
}
