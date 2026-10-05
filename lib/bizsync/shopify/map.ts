// ShapesOS — Phase 11 (bizsync): Shopify payload → normalized records → Ops
// fields (PURE).
//
// Two documented payload shapes arrive: Admin GraphQL nodes (pulls; ids are
// "gid://shopify/Product/123") and REST-shaped webhook bodies (orders/*,
// products/*, customers/*, inventory_levels/update; numeric ids plus
// admin_graphql_api_id). Both normalize to the same types here, so a pull
// and a webhook for the same object land on the same biz_sync_links row
// (keyed by the GraphQL gid).
//
// Ops mapping rules (documented, asserted in lib/bizsync/__tests__):
//   product   one Shopify product → one OpsProduct. A single-variant product
//             ("Default Title") maps its variant to the product's default
//             variant and uses the variant SKU as the product SKU; a
//             multi-variant product gets SKU "SHOPIFY-P<id>" and one
//             OpsProductVariant per Shopify variant. A variant without a
//             SKU gets "SHOPIFY-V<id>". DRAFT/ARCHIVED → inactive.
//   order     one Shopify order → one OpsOrder (source "shopify"):
//             cancelled/voided → cancelled; FULFILLED → fulfilled; paid,
//             partially paid/refunded, refunded or authorized → confirmed;
//             else (pending, expired…) → draft. Totals are Shopify's (shop
//             currency). Imported orders never post to the journal and never
//             move stock (Shopify's stock arrives through the inventory sync).
//   customer  → OpsContact (dedupe by lower-cased email).

import type { GqlCustomer, GqlInventoryLevel, GqlMoney, GqlOrder, GqlProduct } from "./api";

export const GID = {
  product: (n: string | number) => `gid://shopify/Product/${n}`,
  variant: (n: string | number) => `gid://shopify/ProductVariant/${n}`,
  order: (n: string | number) => `gid://shopify/Order/${n}`,
  customer: (n: string | number) => `gid://shopify/Customer/${n}`,
  location: (n: string | number) => `gid://shopify/Location/${n}`,
  inventoryItem: (n: string | number) => `gid://shopify/InventoryItem/${n}`,
};

/** "gid://shopify/Product/123" → "123" (else the input). */
export function gidNumber(gid: string): string {
  const m = /\/(\d+)$/.exec(gid);
  return m ? m[1] : gid;
}

/** "12.50" → 1250. Bad input → 0. Never negative. */
export function moneyToCents(v: unknown): number {
  const s = typeof v === "number" ? v.toFixed(2) : typeof v === "string" ? v.trim() : "";
  const m = /^(\d+)(?:\.(\d{1,}))?$/.exec(s);
  if (!m) return 0;
  const frac = ((m[2] ?? "") + "000").slice(0, 3);
  return Number(m[1]) * 100 + Math.round(Number(frac) / 10);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const dateIso = (v: unknown): string => {
  const s = str(v);
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
};

// ---------------------------------------------------------------------------
// Normalized types
// ---------------------------------------------------------------------------

export interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  priceCents: number;
  inventoryItemId: string | null;
  tracked: boolean;
  options: Record<string, string>;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  variants: ShopifyVariant[];
}

export interface ShopifyOrderLine {
  name: string;
  sku: string | null;
  qty: number;
  priceCents: number;
  variantId: string | null;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  financialStatus: string;
  fulfillmentStatus: string;
  email: string | null;
  customerName: string | null;
  customerId: string | null;
  currency: string | null;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  refundedCents: number;
  lines: ShopifyOrderLine[];
}

export interface ShopifyCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  updatedAt: string;
}

export interface ShopifyLevel {
  inventoryItemId: string;
  locationId: string;
  available: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// GraphQL → normalized
// ---------------------------------------------------------------------------

const shopMoney = (m: GqlMoney | undefined) => moneyToCents(m?.shopMoney?.amount);

export function productFromGql(p: GqlProduct): ShopifyProduct {
  return {
    id: p.id,
    title: (str(p.title) ?? `Shopify product ${gidNumber(p.id)}`).slice(0, 200),
    status: String(p.status ?? "ACTIVE").toUpperCase(),
    updatedAt: dateIso(p.updatedAt),
    variants: (p.variants?.nodes ?? []).map((v) => ({
      id: v.id,
      title: (str(v.title) ?? "").slice(0, 200),
      sku: str(v.sku)?.slice(0, 120) ?? null,
      priceCents: moneyToCents(v.price),
      inventoryItemId: str(v.inventoryItem?.id),
      tracked: v.inventoryItem?.tracked !== false,
      options: Object.fromEntries((v.selectedOptions ?? []).filter((o) => o.name && o.value).map((o) => [String(o.name), String(o.value)])),
    })),
  };
}

export function orderFromGql(o: GqlOrder): ShopifyOrder {
  return {
    id: o.id,
    name: str(o.name) ?? `#${gidNumber(o.id)}`,
    createdAt: dateIso(o.createdAt),
    updatedAt: dateIso(o.updatedAt),
    processedAt: o.processedAt ? dateIso(o.processedAt) : null,
    cancelledAt: o.cancelledAt ? dateIso(o.cancelledAt) : null,
    financialStatus: String(o.displayFinancialStatus ?? "PENDING").toUpperCase(),
    fulfillmentStatus: String(o.displayFulfillmentStatus ?? "UNFULFILLED").toUpperCase(),
    email: str(o.email)?.toLowerCase() ?? null,
    customerName: str(o.customer?.displayName),
    customerId: str(o.customer?.id),
    currency: str(o.currencyCode ?? o.totalPriceSet?.shopMoney?.currencyCode),
    subtotalCents: shopMoney(o.subtotalPriceSet),
    taxCents: shopMoney(o.totalTaxSet),
    discountCents: shopMoney(o.totalDiscountsSet),
    totalCents: shopMoney(o.totalPriceSet),
    refundedCents: shopMoney(o.totalRefundedSet),
    lines: (o.lineItems?.nodes ?? []).map((l) => ({
      name: (str(l.name) ?? "Item").slice(0, 200),
      sku: str(l.sku),
      qty: Math.max(0, Math.floor(Number(l.quantity ?? 0))),
      priceCents: shopMoney(l.originalUnitPriceSet),
      variantId: str(l.variant?.id),
    })),
  };
}

export function customerFromGql(c: GqlCustomer): ShopifyCustomer {
  const email = str(c.defaultEmailAddress?.emailAddress)?.toLowerCase() ?? null;
  const name = [str(c.firstName), str(c.lastName)].filter(Boolean).join(" ") || str(c.displayName) || email || `Shopify customer ${gidNumber(c.id)}`;
  return { id: c.id, name: name.slice(0, 200), email, phone: str(c.defaultPhoneNumber?.phoneNumber), updatedAt: dateIso(c.updatedAt) };
}

export function levelFromGql(l: GqlInventoryLevel, locationId: string): ShopifyLevel | null {
  const item = str(l.item?.id);
  if (!item) return null;
  const q = (l.quantities ?? []).find((x) => x.name === "available");
  return { inventoryItemId: item, locationId, available: Number.isFinite(q?.quantity) ? Number(q!.quantity) : 0, updatedAt: dateIso(l.updatedAt) };
}

// ---------------------------------------------------------------------------
// REST webhook bodies → normalized
// (shopify.dev/docs/api/webhooks — orders/create, products/update, …)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const restGid = (body: Json, make: (n: string) => string): string | null => str(body.admin_graphql_api_id) ?? (str(body.id) ? make(str(body.id)!) : null);

export function productFromRest(b: Json): ShopifyProduct | null {
  const id = restGid(b, GID.product);
  if (!id) return null;
  const variants = Array.isArray(b.variants) ? (b.variants as Json[]) : [];
  return {
    id,
    title: (str(b.title) ?? `Shopify product ${gidNumber(id)}`).slice(0, 200),
    status: String(b.status ?? "active").toUpperCase(),
    updatedAt: dateIso(b.updated_at),
    variants: variants.flatMap((v) => {
      const vid = restGid(v, GID.variant);
      if (!vid) return [];
      const options: Record<string, string> = {};
      for (const k of ["option1", "option2", "option3"]) if (str(v[k])) options[k] = str(v[k])!;
      return [{
        id: vid,
        title: (str(v.title) ?? "").slice(0, 200),
        sku: str(v.sku)?.slice(0, 120) ?? null,
        priceCents: moneyToCents(v.price),
        inventoryItemId: str(v.inventory_item_id) ? GID.inventoryItem(str(v.inventory_item_id)!) : null,
        // REST: inventory_management "shopify" = tracked; null = not tracked (absent → tracked).
        tracked: v.inventory_management !== null,
        options,
      }];
    }),
  };
}

const REST_FINANCIAL: Record<string, string> = {
  paid: "PAID",
  pending: "PENDING",
  authorized: "AUTHORIZED",
  partially_paid: "PARTIALLY_PAID",
  partially_refunded: "PARTIALLY_REFUNDED",
  refunded: "REFUNDED",
  voided: "VOIDED",
  expired: "EXPIRED",
};

export function orderFromRest(b: Json): ShopifyOrder | null {
  const id = restGid(b, GID.order);
  if (!id) return null;
  const customer = (b.customer ?? null) as Json | null;
  const refunds = Array.isArray(b.refunds) ? (b.refunds as Json[]) : [];
  const refunded = refunds.reduce((s, r) => {
    const txs = Array.isArray(r.transactions) ? (r.transactions as Json[]) : [];
    return s + txs.filter((t) => t.kind === "refund" && t.status === "success").reduce((x, t) => x + moneyToCents(t.amount), 0);
  }, 0);
  const lines = Array.isArray(b.line_items) ? (b.line_items as Json[]) : [];
  return {
    id,
    name: str(b.name) ?? `#${gidNumber(id)}`,
    createdAt: dateIso(b.created_at),
    updatedAt: dateIso(b.updated_at),
    processedAt: b.processed_at ? dateIso(b.processed_at) : null,
    cancelledAt: b.cancelled_at ? dateIso(b.cancelled_at) : null,
    financialStatus: REST_FINANCIAL[String(b.financial_status ?? "pending")] ?? String(b.financial_status ?? "PENDING").toUpperCase(),
    fulfillmentStatus: b.fulfillment_status === "fulfilled" ? "FULFILLED" : b.fulfillment_status === "partial" ? "PARTIALLY_FULFILLED" : "UNFULFILLED",
    email: (str(b.email) ?? str(customer?.email))?.toLowerCase() ?? null,
    customerName: customer ? [str(customer.first_name), str(customer.last_name)].filter(Boolean).join(" ") || null : null,
    customerId: customer ? restGid(customer, GID.customer) : null,
    currency: str(b.currency),
    subtotalCents: moneyToCents(b.subtotal_price),
    taxCents: moneyToCents(b.total_tax),
    discountCents: moneyToCents(b.total_discounts),
    totalCents: moneyToCents(b.total_price),
    refundedCents: refunded,
    lines: lines.map((l) => ({
      name: (str(l.name) ?? str(l.title) ?? "Item").slice(0, 200),
      sku: str(l.sku),
      qty: Math.max(0, Math.floor(Number(l.quantity ?? 0))),
      priceCents: moneyToCents(l.price),
      variantId: str(l.variant_id) ? GID.variant(str(l.variant_id)!) : null,
    })),
  };
}

export function customerFromRest(b: Json): ShopifyCustomer | null {
  const id = restGid(b, GID.customer);
  if (!id) return null;
  const email = str(b.email)?.toLowerCase() ?? null;
  const name = [str(b.first_name), str(b.last_name)].filter(Boolean).join(" ") || email || `Shopify customer ${gidNumber(id)}`;
  return { id, name: name.slice(0, 200), email, phone: str(b.phone), updatedAt: dateIso(b.updated_at) };
}

export function levelFromRest(b: Json): ShopifyLevel | null {
  const item = str(b.inventory_item_id);
  const loc = str(b.location_id);
  if (!item || !loc) return null;
  return { inventoryItemId: GID.inventoryItem(item), locationId: GID.location(loc), available: Math.floor(Number(b.available ?? 0)) || 0, updatedAt: dateIso(b.updated_at) };
}

// ---------------------------------------------------------------------------
// Normalized → Ops fields
// ---------------------------------------------------------------------------

export function isSingleVariant(p: ShopifyProduct): boolean {
  return p.variants.length <= 1;
}

export function variantSku(v: Pick<ShopifyVariant, "id" | "sku">): string {
  return v.sku ?? `SHOPIFY-V${gidNumber(v.id)}`;
}

export function productFields(p: ShopifyProduct): { name: string; sku: string; priceCents: number; active: boolean; trackInventory: boolean } {
  const first = p.variants[0];
  return {
    name: p.title,
    sku: isSingleVariant(p) && first ? variantSku(first) : `SHOPIFY-P${gidNumber(p.id)}`,
    priceCents: first?.priceCents ?? 0,
    active: p.status === "ACTIVE",
    trackInventory: p.variants.length === 0 ? false : p.variants.some((v) => v.tracked),
  };
}

export function variantName(p: ShopifyProduct, v: ShopifyVariant): string {
  return (v.title && v.title !== "Default Title" ? `${p.title} — ${v.title}` : p.title).slice(0, 200);
}

export type OpsOrderStatusName = "draft" | "confirmed" | "fulfilled" | "cancelled";

export function orderStatus(o: Pick<ShopifyOrder, "cancelledAt" | "financialStatus" | "fulfillmentStatus">): OpsOrderStatusName {
  if (o.cancelledAt || o.financialStatus === "VOIDED") return "cancelled";
  if (o.fulfillmentStatus === "FULFILLED") return "fulfilled";
  if (["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "REFUNDED", "AUTHORIZED"].includes(o.financialStatus)) return "confirmed";
  return "draft";
}

export function isPaid(o: Pick<ShopifyOrder, "financialStatus">): boolean {
  return ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(o.financialStatus);
}

export interface OpsOrderLine {
  name: string;
  sku?: string;
  qty: number;
  priceCents: number;
  productId?: string;
  variantId?: string;
}

export function orderFields(
  o: ShopifyOrder,
  variantMap: ReadonlyMap<string, { productId: string; variantId: string }>,
): {
  lineItems: OpsOrderLine[];
  status: OpsOrderStatusName;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  customerEmail: string | null;
  customerName: string | null;
  paidAt: Date | null;
} {
  return {
    lineItems: o.lines.map((l) => {
      const local = l.variantId ? variantMap.get(l.variantId) : undefined;
      return {
        name: l.name,
        ...(l.sku ? { sku: l.sku } : {}),
        qty: l.qty,
        priceCents: l.priceCents,
        ...(local ? { productId: local.productId, variantId: local.variantId } : {}),
      };
    }),
    status: orderStatus(o),
    subtotalCents: o.subtotalCents,
    taxCents: o.taxCents,
    discountCents: o.discountCents,
    totalCents: o.totalCents,
    customerEmail: o.email,
    customerName: o.customerName,
    paidAt: isPaid(o) ? new Date(o.processedAt ?? o.createdAt) : null,
  };
}
