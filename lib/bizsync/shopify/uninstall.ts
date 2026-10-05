// ShapesOS — Phase 14 (connectors): Shopify app/uninstalled.
//
// Shopify sends app/uninstalled (X-Shopify-Topic: app/uninstalled) when the
// merchant removes the app from the store; the token is dead from then on.
// The body is the Shop resource (sample: shopify.dev/docs/api/webhooks/latest
// → app/uninstalled: { "id": 548380009, "name": "Super Toys", "domain": …,
// "myshopify_domain": … }); the store is also named in the
// X-Shopify-Shop-Domain header (shopify.dev/docs/apps/build/webhooks/
// delivery-structure#headers). Subscribed per shop through the Admin API with
// the other topics (registerShopifyWebhooks — APP_UNINSTALLED).
//
// Handling (the route verified the HMAC with this workspace's secret first):
//   * every Shopify connection in this workspace for THAT store → revoked
//     (agent tools refuse a non-active connection, the Business sync page and
//     the webhook apply only use active ones, the token refresh leaves a
//     revoked single-store connection alone);
//   * the Tier-W graph connector → revoked (verifyTierWWebhook answers 410 for
//     anything that still arrives: ingest stopped, history kept);
//   * one biz_sync_runs row ("app_uninstalled") so the person sees why.
// Nothing is deleted: synced Ops records stay (they are the workspace's own
// data), and the link table keeps the mapping for a later reconnect.
// Idempotent: a repeated delivery finds nothing active and says so.

import type { GraphConnector } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { withWorkspaceScope as graphScope } from "@/lib/substrate/graph/rls";
import { normalizeShopDomain } from "./shop";

export const APP_UNINSTALLED_TOPIC = "app/uninstalled";

/** The store an app/uninstalled delivery is about (header first, then the Shop body). PURE. */
export function uninstalledShop(headerShop: string | null | undefined, body: Record<string, unknown>): string | null {
  return (
    normalizeShopDomain(headerShop ?? null) ??
    normalizeShopDomain(typeof body.myshopify_domain === "string" ? body.myshopify_domain : null) ??
    normalizeShopDomain(typeof body.domain === "string" ? body.domain : null)
  );
}

function shopOfMeta(meta: unknown): string | null {
  const m = (meta ?? {}) as Record<string, unknown>;
  return normalizeShopDomain(typeof m.shop === "string" ? m.shop : null);
}

export async function handleShopifyAppUninstalled(
  workspaceId: string,
  connector: Pick<GraphConnector, "id" | "authRef">,
  headerShop: string | null,
  body: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string; revoked: number }> {
  const shop = uninstalledShop(headerShop, body);
  const conns = await prisma.connectorConnection.findMany({
    where: { workspaceId, connectorKey: "shopify", status: { in: ["active", "needs_reauth"] } },
    select: { id: true, meta: true },
  });
  // The store named by the delivery; with no store named, only the
  // connection this webhook route is wired to (authRef).
  const targets = conns.filter((c) => (shop ? shopOfMeta(c.meta) === shop : c.id === connector.authRef));
  if (targets.length === 0) {
    return { applied: false, detail: shop ? `no active Shopify connection for ${shop} — nothing to revoke` : "no active Shopify connection — nothing to revoke", revoked: 0 };
  }
  const ids = targets.map((t) => t.id);
  await prisma.connectorConnection.updateMany({ where: { id: { in: ids }, workspaceId }, data: { status: "revoked" } });
  const stopIngest = connector.authRef !== null && ids.includes(connector.authRef);
  if (stopIngest) {
    await graphScope(workspaceId, (tx) => tx.graphConnector.updateMany({ where: { id: connector.id, workspaceId }, data: { status: "revoked" } }));
  }
  const detail = `app uninstalled from ${shop ?? "the store"}: ${ids.length} connection(s) revoked${stopIngest ? ", webhook ingest stopped" : ""}`;
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.bizSyncRun.create({
      data: { workspaceId, provider: "shopify", operation: "app_uninstalled", actor: "webhook:shopify", status: "succeeded", summary: { revoked: ids.length, shop, stopIngest }, finishedAt: new Date() },
    }),
  );
  return { applied: true, detail, revoked: ids.length };
}
