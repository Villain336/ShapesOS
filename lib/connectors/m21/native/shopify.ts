// ShapesOS — Phase 11 (bizsync): Shopify adapter (native, OAuth app install).
//
// LIVE WIRING: Shopify OAuth per store (lib/vault/oauth.ts "shopify": the
// store domain travels in the signed state, the callback hmac is verified,
// the shop lands in the credential payload) → Admin GraphQL API
// (lib/bizsync/shopify/api.ts) and the sync engine (lib/bizsync/shopify/sync.ts):
//   list_locations     Shopify locations + the OpsLocation each maps to (read)
//   sync_from_shopify  pull catalogue / inventory / orders / customers into
//                      Ops (idempotent through biz_sync_links; inventory
//                      differences are booked as adjustment moves; orders
//                      never post to the journal)  [mutating — it writes your
//                      Ops records: import_commerce_data, Tier 2, asks]
//   push_inventory     local on-hand → Shopify "available" at mapped
//                      locations (refused over newer Shopify changes unless
//                      force)  [mutating — update_store_inventory, asks]
//   register_webhooks  subscribe the store's orders/products/customers/
//                      inventory webhooks (+ app/uninstalled, Phase 14) to
//                      the existing signed Tier-W ingest route  [mutating —
//                      connector_write, asks]
// Phase 14 (connectors): the credential may also come from the single-store
// connection (lib/bizsync/shopify/single-store.ts — a Dev Dashboard app's
// client-credentials token or an existing custom app's token); it is stored
// with the same { access_token, shop } keys, so nothing here changes.
// Every run is logged in biz_sync_runs (Settings → Connectors → Business sync).
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected" via withNoFakesGuard): labelled "(MOCK)" data; mock syncs and
// pushes write nothing.

import type { ConnectorAdapter, ConnectorToolDef, DecryptedCredential, InvokeContext, InvokeResult } from "../types";
import { boolProp, fail, liveOk, mockOk, numProp, strProp } from "../types";
import { liveFailure, type LiveDeps } from "../live/http";
import type { ShopifyAuth } from "@/lib/bizsync/shopify/api";
import { inputFailure } from "./outlook";

/** Shopify auth from a vault credential (null → mock mode). */
export function shopifyAuthFrom(credential: DecryptedCredential | null, ctx?: Pick<InvokeContext, "refreshCredential">): ShopifyAuth | null {
  const token = credential?.payload?.access_token;
  const shop = credential?.payload?.shop;
  if (typeof token !== "string" || !token || typeof shop !== "string" || !shop) return null;
  const refresher = ctx?.refreshCredential;
  return {
    shop,
    token,
    refresh: refresher
      ? async () => {
          const next = await refresher();
          const t = next?.payload?.access_token;
          return typeof t === "string" && t ? t : null;
        }
      : undefined,
  };
}

const PARTS = ["catalog", "inventory", "orders", "customers"] as const;
type Part = (typeof PARTS)[number];

export function parseParts(v: unknown): Part[] {
  if (typeof v !== "string" || !v.trim()) return [...PARTS];
  const out = v.split(",").map((s) => s.trim().toLowerCase());
  for (const p of out) if (!(PARTS as readonly string[]).includes(p)) throw new Error(`parts must be a comma-separated subset of ${PARTS.join(",")}`);
  // Catalogue first: inventory and orders resolve variants through it.
  return PARTS.filter((p) => out.includes(p));
}

export class ShopifyAdapter implements ConnectorAdapter {
  readonly key = "shopify";
  readonly displayName = "Shopify";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_locations",
        description: "List the Shopify store's locations and the stock location each one maps to.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "sync_from_shopify",
        description:
          "Pull Shopify products/variants, inventory levels, orders and customers into Ops (never duplicates; stock differences are booked as adjustments; orders are not posted to the books). Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            parts: strProp('Comma-separated subset of "catalog,inventory,orders,customers" (default all).'),
            maxPages: numProp("Pages per part (default 20; orders 10)."),
            updatedSince: strProp("Orders only: ISO date — only orders updated since then."),
          },
        },
      },
      {
        name: "push_inventory",
        description:
          "Set Shopify's available stock at mapped locations to the local on-hand quantity. Refuses where Shopify changed since the last sync unless force is set. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            productIds: strProp("Comma-separated local product ids (default: every synced item)."),
            force: boolProp("Overwrite newer Shopify changes (default false)."),
          },
        },
      },
      {
        name: "register_webhooks",
        description: "Subscribe the store's order, product, customer and inventory webhooks so changes arrive in Ops automatically. Asks for confirmation first.",
        mutating: true,
        argsSchema: { type: "object", properties: {} },
      },
    ];
  }

  async invoke(tool: string, args: Record<string, unknown>, credential: DecryptedCredential | null, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = shopifyAuthFrom(credential, ctx);
    if (!auth) return this.mock(tool);
    const ws = ctx.workspaceId;
    try {
      const sync = await import("@/lib/bizsync/shopify/sync");
      const { recordRun, mergeReports, emptyReport } = await import("@/lib/bizsync/links");
      switch (tool) {
        case "list_locations": {
          const { shopifyLocations } = await import("@/lib/bizsync/shopify/api");
          const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
          const locs = await shopifyLocations(auth, this.deps);
          const links = await withWorkspaceScope(ws, (tx) => tx.bizSyncLink.findMany({ where: { workspaceId: ws, provider: "shopify", objectType: "location" }, select: { remoteId: true, localId: true } }));
          return liveOk(locs.map((l) => ({ id: l.id, name: l.name, active: l.isActive !== false, opsLocationId: links.find((x) => x.remoteId === l.id)?.localId ?? null })));
        }
        case "sync_from_shopify": {
          const parts = parseParts(args.parts);
          const maxPages = Number(args.maxPages) || undefined;
          let report = emptyReport();
          for (const part of parts) {
            const r = await recordRun(ws, "shopify", `sync_${part}`, ctx.userId, () => {
              if (part === "catalog") return sync.pullCatalog(ws, auth, { userId: ctx.userId, maxPages }, this.deps);
              if (part === "inventory") return sync.pullInventory(ws, auth, { userId: ctx.userId, maxPages }, this.deps);
              if (part === "orders") return sync.pullOrders(ws, auth, { maxPages, updatedSince: typeof args.updatedSince === "string" ? args.updatedSince : null }, this.deps);
              return sync.pullCustomers(ws, auth, { maxPages }, this.deps);
            });
            report = mergeReports(report, r);
          }
          return liveOk({ parts, ...report });
        }
        case "push_inventory": {
          const productIds = typeof args.productIds === "string" && args.productIds.trim() ? args.productIds.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
          const force = args.force === true || args.force === "true";
          return liveOk(await recordRun(ws, "shopify", "push_inventory", ctx.userId, () => sync.pushInventory(ws, auth, { userId: ctx.userId, productIds, force }, this.deps)));
        }
        case "register_webhooks": {
          const { appBaseUrl } = await import("@/lib/workspace/invite-mail");
          const base = appBaseUrl();
          if (!base) return { ok: false, mock: false, errorCode: "config_missing", error: "Set APP_URL to the app's public URL so Shopify can reach the webhook route." };
          return liveOk(await recordRun(ws, "shopify", "register_webhooks", ctx.userId, () => sync.registerShopifyWebhooks(ws, auth, base, this.deps)));
        }
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return inputFailure(err, "Shopify");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = shopifyAuthFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Shopify is not connected." };
    try {
      const { shopifyLocations } = await import("@/lib/bizsync/shopify/api");
      const locs = await shopifyLocations(auth, this.deps);
      return liveOk({ reachable: true, locations: locs.length });
    } catch (err) {
      return liveFailure(err, "Shopify");
    }
  }

  private mock(tool: string): InvokeResult {
    switch (tool) {
      case "list_locations":
        return mockOk([{ id: "gid://shopify/Location/1", name: "Main warehouse (MOCK)", active: true, opsLocationId: null, mock: true }]);
      case "sync_from_shopify":
        return mockOk({ created: 0, updated: 0, unchanged: 0, conflicts: [], mock: true, info: "MOCK — Shopify is not connected; nothing was synced." });
      case "push_inventory":
        return mockOk({ pushed: 0, mock: true, info: "MOCK — Shopify is not connected; nothing was pushed." });
      case "register_webhooks":
        return mockOk({ created: [], mock: true, info: "MOCK — Shopify is not connected; no webhooks were registered." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
