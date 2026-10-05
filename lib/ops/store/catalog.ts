// ShapesOS — Phase 10 (store): what a storefront shows and sells.
//
// resolvePublishedStore   slug → store, through the ONE SELECT-only routing
//                         policy on ops_stores (app.store_route = 'lookup';
//                         published rows only). Unknown / unpublished → null.
// loadPublicListings      everything else runs under the tenant GUC
//                         (withWorkspaceScope): listed listings of active
//                         products, their active variants and stock.
// priceCartFor            loads exactly the catalog rows a cart names and
//                         prices them (lib/ops/store/pricing.ts).
//
// Stock comes from the inventory totals: a product's stockQty is the
// on-hand total; per-variant quantities are derived from the ledger
// (OpsInventoryTxn, null variant = the default variant) and any stock that
// predates the ledger stays on the default variant — the same reading the
// ops-core stock views use (lib/ops/stock.ts).

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { defaultVariantId } from "../stock";
import type { Cart } from "./cart";
import { orderLabel } from "./view";
import { itemKey, priceCart, type CatalogItem, type PricedCart, type PromotionRow } from "./pricing";

type Tx = Prisma.TransactionClient;

export const STORE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const LISTING_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;

export interface PublicStore {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  currency: string;
  taxRateId: string | null;
  warehouseId: string | null;
  contactEmail: string | null;
}

const STORE_SELECT = {
  id: true,
  workspaceId: true,
  slug: true,
  name: true,
  description: true,
  currency: true,
  taxRateId: true,
  warehouseId: true,
  contactEmail: true,
} as const;

/** Published store by slug (the routing policy hides everything else). */
export async function resolvePublishedStore(slug: string): Promise<PublicStore | null> {
  if (typeof slug !== "string" || !STORE_SLUG_RE.test(slug)) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.store_route = 'lookup'`);
    return tx.opsStore.findFirst({ where: { slug, published: true }, select: STORE_SELECT });
  });
}

export interface PublicVariant {
  /** Null = the product's default (only) variant. */
  id: string | null;
  name: string;
  sku: string;
  attributes: Record<string, string>;
  priceCents: number;
  /** Null = not stock-tracked. */
  available: number | null;
}

export interface PublicListing {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  hasImage: boolean;
  productId: string;
  sku: string;
  trackInventory: boolean;
  variants: PublicVariant[];
  /** Lowest variant price (what the catalogue shows as "from"). */
  fromPriceCents: number;
  /** Σ available across variants (null = not tracked). */
  available: number | null;
  updatedAt: Date;
}

type ProductRow = { id: string; name: string; sku: string; priceCents: number; stockQty: number; trackInventory: boolean; active: boolean };
type VariantRow = { id: string; productId: string; sku: string; name: string; attributes: unknown; priceCents: number | null; isDefault: boolean; active: boolean };

/** On-hand per variant, from the ledger + the product total (see header). */
async function variantStock(tx: Tx, workspaceId: string, products: ProductRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const tracked = products.filter((p) => p.trackInventory);
  if (tracked.length === 0) return out;
  const groups = await tx.opsInventoryTxn.groupBy({
    by: ["productId", "variantId"],
    where: { workspaceId, productId: { in: tracked.map((p) => p.id) } },
    _sum: { delta: true },
  });
  const ledgerTotal = new Map<string, number>();
  for (const g of groups) {
    const vid = g.variantId ?? defaultVariantId(g.productId);
    const q = g._sum.delta ?? 0;
    out.set(vid, (out.get(vid) ?? 0) + q);
    ledgerTotal.set(g.productId, (ledgerTotal.get(g.productId) ?? 0) + q);
  }
  for (const p of tracked) {
    // Stock booked before the ledger existed lives on the default variant.
    const pre = p.stockQty - (ledgerTotal.get(p.id) ?? 0);
    if (pre !== 0) {
      const dv = defaultVariantId(p.id);
      out.set(dv, (out.get(dv) ?? 0) + pre);
    }
  }
  return out;
}

function attrs(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>;
}

/**
 * The variants a product is sold as: its explicit active variants, or — when
 * it has none — the product itself (default variant, public id null).
 */
function sellableVariants(p: ProductRow, variants: VariantRow[], stock: Map<string, number>): Array<PublicVariant & { variantId: string }> {
  const explicit = variants.filter((v) => v.productId === p.id && !v.isDefault && v.active);
  const avail = (vid: string) => (p.trackInventory ? Math.max(0, stock.get(vid) ?? 0) : null);
  if (explicit.length === 0) {
    const dv = defaultVariantId(p.id);
    return [{ id: null, variantId: dv, name: p.name, sku: p.sku, attributes: {}, priceCents: p.priceCents, available: avail(dv) }];
  }
  return explicit
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((v) => ({
      id: v.id,
      variantId: v.id,
      name: v.name,
      sku: v.sku,
      attributes: attrs(v.attributes),
      priceCents: v.priceCents ?? p.priceCents,
      available: avail(v.id),
    }));
}

/** Listed listings (optionally one slug / some products) of active products. */
async function loadListingRows(
  tx: Tx,
  store: PublicStore,
  filter: { slug?: string; productIds?: string[]; limit?: number } = {},
) {
  return tx.opsStoreListing.findMany({
    where: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      listed: true,
      product: { active: true },
      ...(filter.slug ? { slug: filter.slug } : {}),
      ...(filter.productIds ? { productId: { in: filter.productIds } } : {}),
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    take: filter.limit ?? 500,
    include: {
      product: { select: { id: true, name: true, sku: true, priceCents: true, stockQty: true, trackInventory: true, active: true } },
    },
  });
}

async function buildListings(tx: Tx, store: PublicStore, rows: Awaited<ReturnType<typeof loadListingRows>>) {
  const products = rows.map((r) => r.product as ProductRow);
  const variants = (await tx.opsProductVariant.findMany({
    where: { workspaceId: store.workspaceId, productId: { in: products.map((p) => p.id) } },
    select: { id: true, productId: true, sku: true, name: true, attributes: true, priceCents: true, isDefault: true, active: true },
  })) as VariantRow[];
  const stock = await variantStock(tx, store.workspaceId, products);
  return rows.map((r) => {
    const p = r.product as ProductRow;
    const vs = sellableVariants(p, variants, stock);
    const listing: PublicListing = {
      id: r.id,
      slug: r.slug,
      title: r.title?.trim() || p.name,
      description: r.description,
      hasImage: Boolean(r.imageFileId),
      productId: p.id,
      sku: p.sku,
      trackInventory: p.trackInventory,
      variants: vs.map((v) => ({ id: v.id, name: v.name, sku: v.sku, attributes: v.attributes, priceCents: v.priceCents, available: v.available })),
      fromPriceCents: Math.min(...vs.map((v) => v.priceCents)),
      available: p.trackInventory ? vs.reduce((s, v) => s + (v.available ?? 0), 0) : null,
      updatedAt: r.updatedAt,
    };
    return { listing, product: p, sellable: vs };
  });
}

export async function loadPublicListings(store: PublicStore, filter: { slug?: string } = {}): Promise<PublicListing[]> {
  return withWorkspaceScope(store.workspaceId, async (tx) => {
    const rows = await loadListingRows(tx as Tx, store, filter);
    return (await buildListings(tx as Tx, store, rows)).map((b) => b.listing);
  });
}

export async function loadPublicListing(store: PublicStore, slug: string): Promise<PublicListing | null> {
  if (!LISTING_SLUG_RE.test(slug)) return null;
  return (await loadPublicListings(store, { slug }))[0] ?? null;
}

/** The catalog snapshot for the products a cart names (keyed by cart reference). */
export async function catalogForCart(tx: Tx, store: PublicStore, cart: Cart): Promise<Map<string, CatalogItem>> {
  const ids = [...new Set(cart.lines.map((l) => l.productId))];
  const out = new Map<string, CatalogItem>();
  if (ids.length === 0) return out;
  const rows = await loadListingRows(tx, store, { productIds: ids });
  for (const b of await buildListings(tx, store, rows)) {
    for (const v of b.sellable) {
      out.set(itemKey(b.product.id, v.id), {
        productId: b.product.id,
        variantId: v.variantId,
        publicVariantId: v.id,
        listingId: b.listing.id,
        listingSlug: b.listing.slug,
        name: v.id ? `${b.listing.title} — ${v.name}` : b.listing.title,
        sku: v.sku,
        productSku: b.product.sku,
        unitPriceCents: v.priceCents,
        trackInventory: b.product.trackInventory,
        available: v.available,
        sellable: true,
      });
    }
  }
  return out;
}

export async function promotionByCode(tx: Tx, workspaceId: string, code: string | null): Promise<PromotionRow | null> {
  if (!code) return null;
  const row = await tx.opsPromotion.findFirst({
    where: { workspaceId, code: { equals: code, mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
  });
  return row ? { ...row, rules: row.rules } : null;
}

export async function storeTaxBps(tx: Tx, store: Pick<PublicStore, "workspaceId" | "taxRateId">): Promise<number> {
  if (!store.taxRateId) return 0;
  const r = await tx.opsTaxRate.findFirst({ where: { id: store.taxRateId, workspaceId: store.workspaceId, active: true }, select: { rateBps: true } });
  return r?.rateBps ?? 0;
}

/** Price a cart against the database (call inside withWorkspaceScope). */
export async function priceCartFor(tx: Tx, store: PublicStore, cart: Cart, now: Date = new Date()): Promise<{ priced: PricedCart; catalog: Map<string, CatalogItem> }> {
  const catalog = await catalogForCart(tx, store, cart);
  const priced = priceCart({
    lines: cart.lines,
    catalog,
    promoCode: cart.promoCode,
    promotion: await promotionByCode(tx, store.workspaceId, cart.promoCode),
    taxRateBps: await storeTaxBps(tx, store),
    now,
  });
  return { priced, catalog };
}

/**
 * The thank-you page's view of an order, by its Checkout Session id (an
 * unguessable capability Stripe appends to the success URL). Label, state
 * and total only — never buyer details.
 */
export async function orderForSession(store: PublicStore, sessionId: string): Promise<{ label: string; status: string; totalCents: number } | null> {
  if (!/^cs_[A-Za-z0-9_]{6,255}$/.test(sessionId)) return null;
  const o = await withWorkspaceScope(store.workspaceId, (tx) =>
    tx.opsOrder.findFirst({
      where: { workspaceId: store.workspaceId, storeId: store.id, source: "web", stripeSessionId: sessionId },
      select: { id: true, status: true, totalCents: true },
    }),
  );
  return o ? { label: orderLabel(o.id), status: o.status, totalCents: o.totalCents } : null;
}

/** A listing's image file (for the public image route): id + workspace only. */
export async function listingImage(store: PublicStore, listingId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(listingId)) return null;
  const l = await withWorkspaceScope(store.workspaceId, (tx) =>
    tx.opsStoreListing.findFirst({
      where: { id: listingId, workspaceId: store.workspaceId, storeId: store.id, listed: true, product: { active: true } },
      select: { imageFileId: true },
    }),
  );
  return l?.imageFileId ?? null;
}

/** Can this store take payments (the workspace has its own Stripe key)? */
export async function storePaymentsReady(store: PublicStore): Promise<boolean> {
  const s = await withWorkspaceScope(store.workspaceId, (tx) =>
    tx.opsFinanceSettings.findUnique({ where: { workspaceId: store.workspaceId }, select: { stripeSecretEnc: true } }),
  );
  return Boolean(s?.stripeSecretEnc);
}
