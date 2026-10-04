// ShapesOS — Phase 11 (bizsync): Shopify Admin GraphQL API calls.
//
//   POST https://{shop}/admin/api/{version}/graphql.json
//   header X-Shopify-Access-Token: <offline token>   (not a Bearer token)
// Docs: shopify.dev/docs/api/admin-graphql (products, locations,
// inventoryLevels, orders, customers, inventorySetQuantities,
// webhookSubscriptionCreate). The version is pinned (SHOPIFY_API_VERSION
// overrides; Shopify supports each stable version for 12 months).
//
// Transport is liveRequest (lib/connectors/m21/live/http.ts: safeFetch,
// closed error codes, token scrubbing — the access-token header is redacted
// from error text). GraphQL answers HTTP 200 for query-cost throttling with
// errors[].extensions.code = "THROTTLED"; reads back off and retry, writes
// never retry on ambiguous failures (no duplicate mutations — inventory
// mutations also carry an @idempotent key). The shop host is always a
// validated *.myshopify.com domain (lib/bizsync/shopify/shop.ts).
//
// Everything here is UNVERIFIED-LIVE: tested against a labelled fake Shopify.

import { ConnectorApiError, liveRequest, type LiveDeps } from "@/lib/connectors/m21/live/http";
import { normalizeShopDomain } from "./shop";

const PROVIDER = "Shopify";
export const SHOPIFY_DEFAULT_API_VERSION = "2026-07";

export function shopifyApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.SHOPIFY_API_VERSION ?? "").trim();
  return /^\d{4}-\d{2}$/.test(v) ? v : SHOPIFY_DEFAULT_API_VERSION;
}

export interface ShopifyAuth {
  shop: string;
  token: string;
  /** Expiring offline tokens only: one-shot refresher through the vault. */
  refresh?: () => Promise<string | null>;
}

interface GqlError {
  message?: string;
  extensions?: { code?: string };
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One GraphQL call. Throws ConnectorApiError; returns `data`. */
export async function shopifyGraphql<T>(
  auth: ShopifyAuth,
  query: string,
  variables: Record<string, unknown> = {},
  deps: LiveDeps & { mutation?: boolean } = {},
): Promise<T> {
  const shop = normalizeShopDomain(auth.shop);
  if (!shop) throw new ConnectorApiError(PROVIDER, "config_missing", "The Shopify store domain is missing or invalid — reconnect Shopify.");
  const url = `https://${shop}/admin/api/${shopifyApiVersion()}/graphql.json`;
  const sleep = deps.sleep ?? sleepDefault;
  const maxThrottleRetries = deps.mutation ? 0 : (deps.maxRetries ?? 4);
  let token = auth.token;
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    let res: { data?: T; errors?: GqlError[] } | null;
    try {
      res = await liveRequest<{ data?: T; errors?: GqlError[] }>(
        { provider: PROVIDER, url, method: "POST", headers: { "X-Shopify-Access-Token": token }, json: { query, variables } },
        { ...deps, ...(deps.mutation ? { maxRetries: 0 } : {}) },
      );
    } catch (err) {
      if (err instanceof ConnectorApiError && err.code === "auth_rejected" && auth.refresh && !refreshed) {
        refreshed = true;
        const next = await auth.refresh().catch(() => null);
        if (next) {
          token = next;
          attempt -= 1;
          continue;
        }
      }
      throw err;
    }
    const errors = res?.errors ?? [];
    if (errors.length > 0) {
      if (errors.some((e) => e.extensions?.code === "THROTTLED") && attempt < maxThrottleRetries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const code = errors.some((e) => e.extensions?.code === "ACCESS_DENIED") ? "forbidden" : errors.some((e) => e.extensions?.code === "THROTTLED") ? "rate_limited" : "bad_request";
      throw new ConnectorApiError(PROVIDER, code, `Shopify GraphQL error: ${String(errors[0]?.message ?? "unknown").slice(0, 200)}`);
    }
    if (!res?.data) throw new ConnectorApiError(PROVIDER, "provider_error", "Shopify returned no data.");
    return res.data;
  }
}

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

// ---------------------------------------------------------------------------
// Raw GraphQL shapes (documented subset)
// ---------------------------------------------------------------------------

export interface GqlMoney {
  shopMoney?: { amount?: string; currencyCode?: string };
}

export interface GqlVariant {
  id: string;
  title?: string;
  sku?: string | null;
  price?: string | null;
  updatedAt?: string;
  inventoryItem?: { id?: string; tracked?: boolean } | null;
  selectedOptions?: Array<{ name?: string; value?: string }>;
}

export interface GqlProduct {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: string;
  variants?: { nodes?: GqlVariant[] };
}

export interface GqlOrder {
  id: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  processedAt?: string | null;
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  email?: string | null;
  currencyCode?: string;
  customer?: { id?: string; displayName?: string | null } | null;
  subtotalPriceSet?: GqlMoney;
  totalTaxSet?: GqlMoney;
  totalDiscountsSet?: GqlMoney;
  totalPriceSet?: GqlMoney;
  totalRefundedSet?: GqlMoney;
  lineItems?: { nodes?: Array<{ name?: string; sku?: string | null; quantity?: number; originalUnitPriceSet?: GqlMoney; variant?: { id?: string } | null }> };
}

export interface GqlCustomer {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  updatedAt?: string;
  defaultEmailAddress?: { emailAddress?: string | null } | null;
  defaultPhoneNumber?: { phoneNumber?: string | null } | null;
}

export interface GqlLocation {
  id: string;
  name?: string;
  isActive?: boolean;
}

export interface GqlInventoryLevel {
  updatedAt?: string;
  item?: { id?: string };
  quantities?: Array<{ name?: string; quantity?: number }>;
}

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const PAGE = "pageInfo { hasNextPage endCursor }";

export async function shopifyLocations(auth: ShopifyAuth, deps: LiveDeps = {}): Promise<GqlLocation[]> {
  const d = await shopifyGraphql<{ locations: Page<GqlLocation> }>(auth, `query { locations(first: 100) { nodes { id name isActive } ${PAGE} } }`, {}, deps);
  return d.locations?.nodes ?? [];
}

export async function shopifyProductsPage(auth: ShopifyAuth, after: string | null, deps: LiveDeps = {}): Promise<Page<GqlProduct>> {
  const d = await shopifyGraphql<{ products: Page<GqlProduct> }>(
    auth,
    `query Products($after: String) { products(first: 50, after: $after) { nodes { id title status updatedAt
       variants(first: 100) { nodes { id title sku price updatedAt inventoryItem { id tracked } selectedOptions { name value } } } } ${PAGE} } }`,
    { after },
    deps,
  );
  return d.products;
}

export async function shopifyInventoryLevelsPage(auth: ShopifyAuth, locationId: string, after: string | null, deps: LiveDeps = {}): Promise<Page<GqlInventoryLevel>> {
  const d = await shopifyGraphql<{ location: { inventoryLevels: Page<GqlInventoryLevel> } | null }>(
    auth,
    `query Levels($id: ID!, $after: String) { location(id: $id) { inventoryLevels(first: 100, after: $after) {
       nodes { updatedAt item { id } quantities(names: ["available"]) { name quantity } } ${PAGE} } } }`,
    { id: locationId, after },
    deps,
  );
  return d.location?.inventoryLevels ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
}

export async function shopifyInventoryLevel(auth: ShopifyAuth, inventoryItemId: string, locationId: string, deps: LiveDeps = {}): Promise<{ available: number; updatedAt: string | null } | null> {
  const d = await shopifyGraphql<{ inventoryItem: { inventoryLevel: GqlInventoryLevel | null } | null }>(
    auth,
    `query Level($item: ID!, $loc: ID!) { inventoryItem(id: $item) { inventoryLevel(locationId: $loc) { updatedAt quantities(names: ["available"]) { name quantity } } } }`,
    { item: inventoryItemId, loc: locationId },
    deps,
  );
  const level = d.inventoryItem?.inventoryLevel;
  if (!level) return null;
  return { available: availableOf(level), updatedAt: level.updatedAt ?? null };
}

export function availableOf(level: GqlInventoryLevel): number {
  const q = (level.quantities ?? []).find((x) => x.name === "available");
  return Number.isFinite(q?.quantity) ? Number(q!.quantity) : 0;
}

export async function shopifyOrdersPage(auth: ShopifyAuth, after: string | null, opts: { updatedSince?: string | null } = {}, deps: LiveDeps = {}): Promise<Page<GqlOrder>> {
  const money = "shopMoney { amount currencyCode }";
  const d = await shopifyGraphql<{ orders: Page<GqlOrder> }>(
    auth,
    `query Orders($after: String, $q: String) { orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) { nodes {
       id name createdAt updatedAt processedAt cancelledAt displayFinancialStatus displayFulfillmentStatus email currencyCode
       customer { id displayName }
       subtotalPriceSet { ${money} } totalTaxSet { ${money} } totalDiscountsSet { ${money} } totalPriceSet { ${money} } totalRefundedSet { ${money} }
       lineItems(first: 100) { nodes { name sku quantity originalUnitPriceSet { ${money} } variant { id } } } } ${PAGE} } }`,
    { after, q: opts.updatedSince ? `updated_at:>='${opts.updatedSince}'` : null },
    deps,
  );
  return d.orders;
}

export async function shopifyCustomersPage(auth: ShopifyAuth, after: string | null, deps: LiveDeps = {}): Promise<Page<GqlCustomer>> {
  const d = await shopifyGraphql<{ customers: Page<GqlCustomer> }>(
    auth,
    `query Customers($after: String) { customers(first: 100, after: $after) { nodes { id firstName lastName displayName updatedAt
       defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } } ${PAGE} } }`,
    { after },
    deps,
  );
  return d.customers;
}

export interface SetQuantity {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  /** Shopify's current "available" we read just before; Shopify refuses if it moved since. */
  changeFromQuantity: number;
}

/** Set "available" at locations (a gated write). Never retried; idempotent by key. */
export async function shopifySetQuantities(
  auth: ShopifyAuth,
  quantities: SetQuantity[],
  idempotencyKey: string,
  deps: LiveDeps = {},
): Promise<{ userErrors: UserError[] }> {
  const d = await shopifyGraphql<{ inventorySetQuantities: { userErrors?: UserError[] } | null }>(
    auth,
    `mutation SetQty($input: InventorySetQuantitiesInput!, $key: String!) {
       inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message code } } }`,
    { input: { name: "available", reason: "correction", referenceDocumentUri: "shapesos://inventory-push", quantities }, key: idempotencyKey },
    { ...deps, mutation: true },
  );
  return { userErrors: d.inventorySetQuantities?.userErrors ?? [] };
}

export async function shopifyWebhookSubscriptions(auth: ShopifyAuth, deps: LiveDeps = {}): Promise<Array<{ id: string; topic: string; uri: string | null }>> {
  const d = await shopifyGraphql<{ webhookSubscriptions: Page<{ id: string; topic?: string; uri?: string | null }> }>(
    auth,
    `query { webhookSubscriptions(first: 100) { nodes { id topic uri } ${PAGE} } }`,
    {},
    deps,
  );
  return (d.webhookSubscriptions?.nodes ?? []).map((n) => ({ id: n.id, topic: String(n.topic ?? ""), uri: n.uri ?? null }));
}

export async function shopifyCreateWebhook(auth: ShopifyAuth, topic: string, uri: string, deps: LiveDeps = {}): Promise<{ id: string | null; userErrors: UserError[] }> {
  const d = await shopifyGraphql<{ webhookSubscriptionCreate: { webhookSubscription?: { id?: string } | null; userErrors?: UserError[] } | null }>(
    auth,
    `mutation Hook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
       webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`,
    { topic, sub: { uri, format: "JSON" } },
    { ...deps, mutation: true },
  );
  return { id: d.webhookSubscriptionCreate?.webhookSubscription?.id ?? null, userErrors: d.webhookSubscriptionCreate?.userErrors ?? [] };
}
