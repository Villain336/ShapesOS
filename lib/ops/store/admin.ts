// ShapesOS — Phase 10 (store): store + listing rules for the generic ops
// route (OPS_ENTITIES "stores" / "store-listings" hooks) and the admin
// overview read (/dashboard/ops/store, ops_store_overview).
//
// Every id a store or listing points at must belong to the SAME workspace:
// foreign keys don't see RLS, so a product, tax rate, warehouse or image id
// from another tenant is refused here (404, as if it didn't exist).

import { Prisma } from "@prisma/client";
import { OpsError, OpsNotFoundError, type OpsActor } from "../doctype";
import { INLINE_SAFE_MIMES } from "@/lib/filesystem/download";
import { LISTING_SLUG_RE, STORE_SLUG_RE } from "./catalog";

type Tx = Prisma.TransactionClient;

/** "Blue Mug (Large)" → "blue-mug-large" (empty → "item"). */
export function slugify(raw: string, max = 120): string {
  const s = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "item";
}

function isUnique(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function mustOwn(tx: Tx, what: "tax-rates" | "warehouses" | "products" | "stores", id: string, workspaceId: string): Promise<void> {
  const where = { id, workspaceId };
  const found =
    what === "tax-rates"
      ? await tx.opsTaxRate.findFirst({ where, select: { id: true } })
      : what === "warehouses"
        ? await tx.opsWarehouse.findFirst({ where, select: { id: true } })
        : what === "products"
          ? await tx.opsProduct.findFirst({ where, select: { id: true } })
          : await tx.opsStore.findFirst({ where, select: { id: true } });
  if (!found) throw new OpsNotFoundError(what, id);
}

/** A listing image must be a live, inline-safe image of this workspace. */
async function mustBeImage(tx: Tx, fileId: string, workspaceId: string): Promise<void> {
  const f = await tx.workspaceFile.findFirst({ where: { id: fileId, workspaceId, trashedAt: null }, select: { mimeType: true } });
  if (!f) throw new OpsNotFoundError("files", fileId);
  if (!INLINE_SAFE_MIMES.has(f.mimeType) || !f.mimeType.startsWith("image/")) {
    throw new OpsError(422, "Product images must be PNG, JPEG, GIF or WebP");
  }
}

function storeSlug(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase();
  if (!STORE_SLUG_RE.test(s)) throw new OpsError(400, "Store address may use lowercase letters, digits and hyphens (up to 64), e.g. acme-shop");
  return s;
}

function currency(v: unknown): string {
  const c = String(v ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new OpsError(400, "Currency must be a 3-letter ISO code, e.g. USD");
  return c;
}

async function storeRefs(tx: Tx, actor: OpsActor, body: Record<string, unknown>): Promise<void> {
  if (typeof body.taxRateId === "string") await mustOwn(tx, "tax-rates", body.taxRateId, actor.workspaceId);
  if (typeof body.warehouseId === "string") await mustOwn(tx, "warehouses", body.warehouseId, actor.workspaceId);
}

export async function createStoreRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  await storeRefs(tx, actor, body);
  const existing = await tx.opsStore.findFirst({ where: { workspaceId: actor.workspaceId }, select: { id: true } });
  if (existing) throw new OpsError(409, "This workspace already has a store — edit it instead");
  try {
    return (await tx.opsStore.create({
      data: {
        workspaceId: actor.workspaceId,
        slug: storeSlug(body.slug),
        name: String(body.name).trim(),
        description: (body.description as string | undefined)?.trim() || null,
        currency: body.currency ? currency(body.currency) : "USD",
        published: body.published === true,
        taxRateId: (body.taxRateId as string | undefined) ?? null,
        warehouseId: (body.warehouseId as string | undefined) ?? null,
        contactEmail: (body.contactEmail as string | undefined) ?? null,
        createdBy: actor.userId,
      },
    })) as unknown as Record<string, unknown>;
  } catch (err) {
    if (isUnique(err)) throw new OpsError(409, "That store address is taken — pick another");
    throw err;
  }
}

export async function patchStoreRow(tx: Tx, actor: OpsActor, id: string, patch: Record<string, unknown>) {
  await storeRefs(tx, actor, patch);
  const data: Record<string, unknown> = { ...patch };
  if (patch.slug !== undefined) data.slug = storeSlug(patch.slug);
  if (patch.currency !== undefined) data.currency = currency(patch.currency);
  if (typeof patch.name === "string") data.name = patch.name.trim();
  try {
    const r = await tx.opsStore.updateMany({ where: { id, workspaceId: actor.workspaceId }, data });
    if (r.count !== 1) throw new OpsNotFoundError("stores", id);
  } catch (err) {
    if (isUnique(err)) throw new OpsError(409, "That store address is taken — pick another");
    throw err;
  }
  return (await tx.opsStore.findFirstOrThrow({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Record<string, unknown>;
}

async function uniqueListingSlug(tx: Tx, storeId: string, base: string, exceptId?: string): Promise<string> {
  const root = slugify(base).slice(0, 110);
  for (let i = 1; i < 50; i += 1) {
    const candidate = i === 1 ? root : `${root}-${i}`;
    const clash = await tx.opsStoreListing.findFirst({ where: { storeId, slug: candidate, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (!clash) return candidate;
  }
  throw new OpsError(409, "Couldn't find a free address for this product — set a slug");
}

function listingSlug(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase();
  if (!LISTING_SLUG_RE.test(s)) throw new OpsError(400, "Product address may use lowercase letters, digits and hyphens (up to 120)");
  return s;
}

export async function createListingRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  const storeId = String(body.storeId);
  const productId = String(body.productId);
  await mustOwn(tx, "stores", storeId, actor.workspaceId);
  await mustOwn(tx, "products", productId, actor.workspaceId);
  if (typeof body.imageFileId === "string") await mustBeImage(tx, body.imageFileId, actor.workspaceId);
  const product = await tx.opsProduct.findFirstOrThrow({ where: { id: productId, workspaceId: actor.workspaceId }, select: { name: true } });
  const slug = body.slug !== undefined ? listingSlug(body.slug) : await uniqueListingSlug(tx, storeId, String(body.title ?? product.name));
  try {
    return (await tx.opsStoreListing.create({
      data: {
        workspaceId: actor.workspaceId,
        storeId,
        productId,
        slug,
        title: (body.title as string | undefined)?.trim() || null,
        description: (body.description as string | undefined)?.trim() || null,
        imageFileId: (body.imageFileId as string | undefined) ?? null,
        position: (body.position as number | undefined) ?? 0,
        listed: body.listed !== false,
      },
    })) as unknown as Record<string, unknown>;
  } catch (err) {
    if (isUnique(err)) throw new OpsError(409, "This product is already in the store, or that address is taken");
    throw err;
  }
}

export async function patchListingRow(tx: Tx, actor: OpsActor, id: string, patch: Record<string, unknown>) {
  const existing = await tx.opsStoreListing.findFirst({ where: { id, workspaceId: actor.workspaceId }, select: { storeId: true } });
  if (!existing) throw new OpsNotFoundError("store-listings", id);
  if (typeof patch.imageFileId === "string") await mustBeImage(tx, patch.imageFileId, actor.workspaceId);
  const data: Record<string, unknown> = { ...patch };
  if (patch.slug !== undefined) data.slug = listingSlug(patch.slug);
  try {
    await tx.opsStoreListing.updateMany({ where: { id, workspaceId: actor.workspaceId }, data });
  } catch (err) {
    if (isUnique(err)) throw new OpsError(409, "That product address is taken in this store");
    throw err;
  }
  return (await tx.opsStoreListing.findFirstOrThrow({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Overview (admin page + agent tool)
// ---------------------------------------------------------------------------

export interface StoreOverview {
  store: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    published: boolean;
    currency: string;
    taxRateId: string | null;
    warehouseId: string | null;
    contactEmail: string | null;
  } | null;
  stripeConnected: boolean;
  stripeWebhookConfigured: boolean;
  listings: Array<{
    id: string;
    productId: string;
    productName: string;
    sku: string;
    slug: string;
    title: string | null;
    description: string | null;
    imageFileId: string | null;
    position: number;
    listed: boolean;
    productActive: boolean;
    priceCents: number;
    stockQty: number;
    trackInventory: boolean;
  }>;
  webOrders: { draft: number; confirmed: number; fulfilled: number; cancelled: number; paidCents30d: number };
}

export async function storeOverview(tx: Tx, workspaceId: string, now: Date = new Date()): Promise<StoreOverview> {
  const [store, fin] = await Promise.all([
    tx.opsStore.findFirst({ where: { workspaceId } }),
    tx.opsFinanceSettings.findUnique({ where: { workspaceId }, select: { stripeSecretEnc: true, stripeWebhookSecretEnc: true } }),
  ]);
  const listings = store
    ? await tx.opsStoreListing.findMany({
        where: { workspaceId, storeId: store.id },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        include: { product: { select: { name: true, sku: true, active: true, priceCents: true, stockQty: true, trackInventory: true } } },
        take: 500,
      })
    : [];
  const counts = await tx.opsOrder.groupBy({ by: ["status"], where: { workspaceId, source: "web" }, _count: { _all: true } });
  const paid = await tx.opsOrder.aggregate({
    where: { workspaceId, source: "web", paidAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
    _sum: { totalCents: true },
  });
  const c = (s: string) => counts.find((g) => g.status === s)?._count._all ?? 0;
  return {
    store: store
      ? {
          id: store.id,
          slug: store.slug,
          name: store.name,
          description: store.description,
          published: store.published,
          currency: store.currency,
          taxRateId: store.taxRateId,
          warehouseId: store.warehouseId,
          contactEmail: store.contactEmail,
        }
      : null,
    stripeConnected: Boolean(fin?.stripeSecretEnc),
    stripeWebhookConfigured: Boolean(fin?.stripeWebhookSecretEnc),
    listings: listings.map((l) => ({
      id: l.id,
      productId: l.productId,
      productName: l.product.name,
      sku: l.product.sku,
      slug: l.slug,
      title: l.title,
      description: l.description,
      imageFileId: l.imageFileId,
      position: l.position,
      listed: l.listed,
      productActive: l.product.active,
      priceCents: l.product.priceCents,
      stockQty: l.product.stockQty,
      trackInventory: l.product.trackInventory,
    })),
    webOrders: { draft: c("draft"), confirmed: c("confirmed"), fulfilled: c("fulfilled"), cancelled: c("cancelled"), paidCents30d: paid._sum.totalCents ?? 0 },
  };
}
