// ShapesOS — Phase 11 (bizsync): what happens right after a connect
// (called from lib/vault/callback.ts handleOAuthCallback, and — Phase 14 —
// from lib/bizsync/shopify/single-store.ts for a single-store connection).
//
//   shopify  Signed Shopify webhooks reuse the existing Tier-W ingest route
//            (/api/substrate/graph/webhooks/shopify?workspaceId=…), which
//            resolves its GraphConnector per (workspace, platform). We upsert
//            that row pointing at the new connection (authRef).
//              OAuth (hosted ShapesOS app): webhooks are verified with the
//              app's client secret (resolveWebhookSecret "app" mode).
//              Phase 14 single store: the connection's own vault payload
//              holds webhook_secret (the Dev Dashboard app's client secret, or
//              an admin-created app's API secret key), so webhookSecretRef
//              points at the connection — never at the hosted app's secret.
//   gusto    Phase 14: the one company the token covers (GET /v1/token_info)
//            labels the connection; a failure here never fails the connect
//            (the adapter resolves the company again on use).
//   xero     The organisation(s) the user granted come from
//            GET https://api.xero.com/connections — kept as connection meta;
//            the first is selected until a person picks another
//            (lib/bizsync/xero/tenants.ts).

import type { ConnectorConnection } from "@prisma/client";
import { withWorkspaceScope as graphScope } from "@/lib/substrate/graph/rls";

export async function onBizsyncConnected(input: {
  connectorKey: string;
  connection: ConnectorConnection;
  fetchImpl?: typeof fetch;
  /** Phase 14: a single-store Shopify connection (not the hosted OAuth app). */
  singleStore?: boolean;
}): Promise<void> {
  const { connection } = input;
  if (input.connectorKey === "shopify") {
    const ws = connection.workspaceId;
    await graphScope(ws, async (tx) => {
      const existing = await tx.graphConnector.findUnique({ where: { workspaceId_platform: { workspaceId: ws, platform: "shopify" } }, select: { webhookSecretRef: true } });
      // Single store: verify with this connection's own secret (or refuse
      // honestly when it has none). OAuth: drop a reference to this same
      // connection left over from an earlier single-store connect (its
      // payload no longer carries a secret); a separately configured
      // Tier-W secret is kept.
      const webhookSecretRef = input.singleStore ? connection.id : existing?.webhookSecretRef === connection.id ? null : (existing?.webhookSecretRef ?? null);
      await tx.graphConnector.upsert({
        where: { workspaceId_platform: { workspaceId: ws, platform: "shopify" } },
        create: { workspaceId: ws, platform: "shopify", tier: "webhook", status: "connected", authRef: connection.id, scopesGranted: connection.scopes, webhookSecretRef },
        update: { status: "connected", authRef: connection.id, scopesGranted: connection.scopes, webhookSecretRef },
      });
    });
    return;
  }
  if (input.connectorKey === "gusto") {
    const { getDecryptedCredential } = await import("@/lib/vault/refresh");
    const { gustoCompanyUuid } = await import("./gusto/api");
    const { prisma } = await import("@/lib/prisma");
    const meta = { ...((connection.meta ?? {}) as Record<string, unknown>) };
    try {
      const cred = await getDecryptedCredential(connection.id);
      const token = typeof cred?.payload.access_token === "string" ? cred.payload.access_token : "";
      const uuid = await gustoCompanyUuid({ token }, input.fetchImpl ? { fetchImpl: input.fetchImpl } : {});
      meta.companyUuid = uuid;
      meta.label = `Gusto company ${uuid.slice(0, 8)}`;
      delete meta.gustoError;
    } catch {
      meta.gustoError = "Connected, but Gusto's company could not be read yet — it is retried on first use.";
    }
    await prisma.connectorConnection.update({ where: { id: connection.id }, data: { meta: meta as Record<string, string> } });
    return;
  }
  if (input.connectorKey === "xero") {
    const { recordXeroTenants } = await import("./xero/tenants");
    await recordXeroTenants(connection, input.fetchImpl ? { fetchImpl: input.fetchImpl } : {});
  }
}
