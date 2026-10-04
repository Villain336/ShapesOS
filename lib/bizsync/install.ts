// ShapesOS — Phase 11 (bizsync): what happens right after an OAuth connect
// (called from lib/vault/callback.ts handleOAuthCallback).
//
//   shopify  Signed Shopify webhooks reuse the existing Tier-W ingest route
//            (/api/substrate/graph/webhooks/shopify?workspaceId=…), which
//            resolves its GraphConnector per (workspace, platform). We upsert
//            that row pointing at the new connection (authRef), so app
//            webhooks are verified with the app's client secret
//            (resolveWebhookSecret) and then applied to Ops.
//   xero     The organisation(s) the user granted come from
//            GET https://api.xero.com/connections — kept as connection meta;
//            the first is selected until a person picks another
//            (lib/bizsync/xero/tenants.ts).

import type { ConnectorConnection } from "@prisma/client";
import { withWorkspaceScope as graphScope } from "@/lib/substrate/graph/rls";

export async function onBizsyncConnected(input: { connectorKey: string; connection: ConnectorConnection; fetchImpl?: typeof fetch }): Promise<void> {
  const { connection } = input;
  if (input.connectorKey === "shopify") {
    await graphScope(connection.workspaceId, (tx) =>
      tx.graphConnector.upsert({
        where: { workspaceId_platform: { workspaceId: connection.workspaceId, platform: "shopify" } },
        create: { workspaceId: connection.workspaceId, platform: "shopify", tier: "webhook", status: "connected", authRef: connection.id, scopesGranted: connection.scopes },
        update: { status: "connected", authRef: connection.id, scopesGranted: connection.scopes },
      }),
    );
    return;
  }
}
