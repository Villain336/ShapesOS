// ShapesOS — Phase 11 (bizsync): Shopify ↔ Ops commerce sync.
//
// PULLS (on demand through the gated agent tool, plus signed webhooks):
//   catalogue  products/variants → OpsProduct / OpsProductVariant (rules in
//              ./map.ts); each Shopify inventory item is linked to its local
//              variant (biz_sync_links "inventory_item").
//   locations  every active Shopify location ↔ one OpsLocation. An unmapped
//              location gets its own warehouse "SHOP-<id>" with a "STOCK"
//              zone (reported); people remap it to an existing location in
//              Settings → Connectors → Business sync (setLocationMapping).
//   inventory  Shopify "available" at a mapped location vs the local on-hand
//              of that variant at that location (inventory ledger). A
//              difference is booked as ONE "adjustment" txn (the ledger stays
//              append-only), per the inventory conflict rule below.
//   orders     → OpsOrder source "shopify" (never posts to the journal, never
//              moves stock), plus OpsPayment records (provider "shopify") for
//              paid / refunded money — records only, like Stripe's.
//   customers  → OpsContact (dedupe by email).
// PUSH (gated write, shopify.push_inventory): local on-hand → Shopify
//   "available" through inventorySetQuantities with changeFromQuantity = the
//   value just read (Shopify refuses if it moved in between) and an
//   @idempotent key.
//
// CONFLICT RULES (documented; asserted in lib/bizsync/__tests__):
//   records (product, variant, order, customer): the shared rule
//     (lib/connectors/sync-conflict.ts via lib/bizsync/links.ts applyPulled) —
//     remote changed = Shopify updatedAt newer than at the last sync; local
//     changed = the mapped local fields' fingerprint differs; only Shopify →
//     apply; only local → keep (local_ahead); both → newer wins, reported.
//   inventory levels: the link remembers the quantity both sides agreed on at
//     the last sync. remote changed = Shopify's available ≠ it; local changed
//     = local on-hand ≠ it; equal quantities are "in sync"; otherwise the same
//     rule with Shopify's level updatedAt vs the newest local stock move.
//     A push over a Shopify change is refused unless the local move is newer
//     or force=true.

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { LiveDeps } from "@/lib/connectors/m21/live/http";
import { decideSync, pushAllowedByChanges, type SyncDecision } from "@/lib/connectors/sync-conflict";
import { normalizeEmail } from "@/lib/ops/crm";
import { recordInventoryTxn, type OpsActor } from "@/lib/ops/doctype";
import { createLocationRow, createVariantRow, ensureDefaultVariant, onHandAt } from "@/lib/ops/stock";
import { applyPulled, emptyReport, findLink, fingerprint, recordFailedRun, saveLink, type SyncReport } from "../links";
import {
  shopifyCreateWebhook,
  shopifyCustomersPage,
  shopifyInventoryLevel,
  shopifyInventoryLevelsPage,
  shopifyLocations,
  shopifyOrdersPage,
  shopifyProductsPage,
  shopifySetQuantities,
  shopifyWebhookSubscriptions,
  type ShopifyAuth,
  type SetQuantity,
} from "./api";
import {
  customerFromGql,
  customerFromRest,
  gidNumber,
  isPaid,
  isSingleVariant,
  levelFromGql,
  levelFromRest,
  orderFields,
  orderFromGql,
  orderFromRest,
  productFields,
  productFromGql,
  productFromRest,
  variantName,
  variantSku,
  type ShopifyCustomer,
  type ShopifyLevel,
  type ShopifyOrder,
  type ShopifyProduct,
} from "./map";

type Tx = Prisma.TransactionClient;
const P = "shopify" as const;

const clampPages = (n: number | undefined, def: number) => Math.min(Math.max(Math.floor(n ?? def), 1), 100);

// ---------------------------------------------------------------------------
// Inventory conflict rule (PURE)
// ---------------------------------------------------------------------------

export type InventoryDecision = "in_sync" | SyncDecision;

export function decideInventory(i: { lastQty: number | null; remoteQty: number; localQty: number; remoteAt: Date; localAt: Date }): InventoryDecision {
  if (i.remoteQty === i.localQty) return "in_sync";
  const remoteChanged = i.lastQty === null || i.remoteQty !== i.lastQty;
  const localChanged = i.lastQty === null || i.localQty !== i.lastQty;
  return decideSync({ remoteChanged, localChanged, remoteAt: i.remoteAt, localAt: i.localAt });
}

const qtyOf = (meta: unknown): number | null => {
  const q = (meta as { qty?: unknown } | null)?.qty;
  return typeof q === "number" && Number.isFinite(q) ? q : null;
};

/** Link a remote id to a local id unless that local row already belongs to another remote record. */
async function linkOnce(tx: Tx, ws: string, objectType: string, remoteId: string, localId: string, meta: Record<string, unknown>, report: SyncReport): Promise<boolean> {
  const byLocal = await findLink(tx, ws, P, objectType, { localId });
  if (byLocal && byLocal.remoteId !== remoteId) {
    report.conflicts.push({ objectType, remoteId, localId, resolution: `already linked to Shopify ${byLocal.remoteId}; skipped` });
    return false;
  }
  await saveLink(tx, ws, P, objectType, remoteId, localId, { meta }, "pull");
  return true;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

const productHash = (r: { name: string; sku: string; priceCents: number; active: boolean; trackInventory: boolean }) =>
  fingerprint({ name: r.name, sku: r.sku, priceCents: r.priceCents, active: r.active, trackInventory: r.trackInventory });
const variantHash = (r: { name: string; sku: string; attributes: unknown; priceCents: number | null }) =>
  fingerprint({ name: r.name, sku: r.sku, attributes: r.attributes, priceCents: r.priceCents });

export async function applyProduct(workspaceId: string, p: ShopifyProduct, report: SyncReport, actor: OpsActor): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const f = productFields(p);
    const out = await applyPulled({
      tx, workspaceId, provider: P, objectType: "product", remoteId: p.id, remoteAt: new Date(p.updatedAt), report,
      hashOf: productHash,
      findLocal: async (link) =>
        link ? tx.opsProduct.findFirst({ where: { id: link.localId, workspaceId } }) : tx.opsProduct.findFirst({ where: { workspaceId, sku: f.sku } }),
      create: () => tx.opsProduct.create({ data: { workspaceId, ...f } }),
      update: async (local) => {
        const data: Partial<typeof f> = { ...f };
        if (data.sku !== local.sku && (await tx.opsProduct.findFirst({ where: { workspaceId, sku: f.sku, NOT: { id: local.id } }, select: { id: true } }))) {
          report.conflicts.push({ objectType: "product", remoteId: p.id, localId: local.id, resolution: `SKU ${f.sku} is used by another local product; kept the local SKU` });
          delete data.sku;
        }
        return tx.opsProduct.update({ where: { id: local.id, workspaceId }, data });
      },
    });
    const product = out.local;
    if (!product) return;

    if (isSingleVariant(p)) {
      const v = p.variants[0];
      if (!v) return;
      const dv = await ensureDefaultVariant(tx, actor, product.id);
      const variantId = String(dv.id);
      if (await linkOnce(tx, workspaceId, "variant", v.id, variantId, { productId: product.id }, report)) {
        if (v.inventoryItemId) await linkOnce(tx, workspaceId, "inventory_item", v.inventoryItemId, variantId, { productId: product.id }, report);
      }
      return;
    }

    for (const v of p.variants) {
      const sku = variantSku(v);
      const fields = { name: variantName(p, v), sku, attributes: v.options, priceCents: v.priceCents };
      const link = await findLink(tx, workspaceId, P, "variant", { remoteId: v.id });
      if (!link) {
        const bySku = await tx.opsProductVariant.findFirst({ where: { workspaceId, sku }, select: { productId: true } });
        if (bySku && bySku.productId !== product.id) {
          report.conflicts.push({ objectType: "variant", remoteId: v.id, localId: null, resolution: `SKU ${sku} belongs to another local product; skipped` });
          continue;
        }
      }
      const vOut = await applyPulled({
        tx, workspaceId, provider: P, objectType: "variant", remoteId: v.id, remoteAt: new Date(p.updatedAt), report,
        hashOf: variantHash,
        findLocal: async (l) =>
          l
            ? tx.opsProductVariant.findFirst({ where: { id: l.localId, workspaceId } })
            : tx.opsProductVariant.findFirst({ where: { workspaceId, sku, productId: product.id } }),
        create: async () => {
          const row = await createVariantRow(tx, actor, { productId: product.id, ...fields });
          return tx.opsProductVariant.findFirstOrThrow({ where: { id: String(row.id), workspaceId } });
        },
        update: async (local) => {
          const data: Partial<typeof fields> = { ...fields };
          if (data.sku !== local.sku && (await tx.opsProductVariant.findFirst({ where: { workspaceId, sku, NOT: { id: local.id } }, select: { id: true } }))) {
            report.conflicts.push({ objectType: "variant", remoteId: v.id, localId: local.id, resolution: `SKU ${sku} is used by another local variant; kept the local SKU` });
            delete data.sku;
          }
          return tx.opsProductVariant.update({ where: { id: local.id, workspaceId }, data: { ...data, attributes: data.attributes as Prisma.InputJsonValue } });
        },
        meta: { productId: product.id },
      });
      if (vOut.local && v.inventoryItemId) await linkOnce(tx, workspaceId, "inventory_item", v.inventoryItemId, vOut.local.id, { productId: product.id }, report);
    }
  });
}

export async function pullCatalog(workspaceId: string, auth: ShopifyAuth, opts: { userId: string; maxPages?: number }, deps: LiveDeps = {}): Promise<SyncReport> {
  const report = emptyReport();
  const actor: OpsActor = { workspaceId, userId: opts.userId };
  let after: string | null = null;
  const max = clampPages(opts.maxPages, 20);
  for (let i = 0; i < max; i++) {
    const page = await shopifyProductsPage(auth, after, deps);
    report.pages += 1;
    for (const node of page.nodes ?? []) await applyProduct(workspaceId, productFromGql(node), report, actor);
    if (!page.pageInfo?.hasNextPage) return report;
    after = page.pageInfo.endCursor;
  }
  report.truncated = true;
  return report;
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface MappedLocation {
  opsLocationId: string;
  name: string;
}

export async function syncLocations(workspaceId: string, auth: ShopifyAuth, actor: OpsActor, report: SyncReport, deps: LiveDeps = {}): Promise<Map<string, MappedLocation>> {
  const map = new Map<string, MappedLocation>();
  for (const loc of await shopifyLocations(auth, deps)) {
    if (loc.isActive === false) continue;
    const name = String(loc.name ?? `Location ${gidNumber(loc.id)}`).slice(0, 100);
    const mapped = await withWorkspaceScope(workspaceId, async (tx) => {
      const link = await findLink(tx, workspaceId, P, "location", { remoteId: loc.id });
      if (link && (await tx.opsLocation.findFirst({ where: { id: link.localId, workspaceId }, select: { id: true } }))) return link.localId;
      const code = `SHOP-${gidNumber(loc.id)}`.slice(0, 40);
      const wh =
        (await tx.opsWarehouse.findFirst({ where: { workspaceId, code } })) ??
        (await tx.opsWarehouse.create({ data: { workspaceId, name: `Shopify: ${name}`.slice(0, 120), code } }));
      const existing = await tx.opsLocation.findFirst({ where: { workspaceId, warehouseId: wh.id, code: "STOCK" } });
      const opsLoc = existing ?? (await createLocationRow(tx, actor, { warehouseId: wh.id, kind: "zone", code: "STOCK", name: "Shopify stock" }));
      const opsLocationId = String(opsLoc.id);
      if (!(await linkOnce(tx, workspaceId, "location", loc.id, opsLocationId, { name }, report))) return null;
      report.created += 1;
      report.notes.push(`Shopify location "${name}" → new warehouse ${code} (remap it in Settings → Connectors → Business sync if it is an existing location).`);
      return opsLocationId;
    });
    if (mapped) map.set(loc.id, { opsLocationId: mapped, name });
  }
  return map;
}

/** A person maps a Shopify location onto an existing OpsLocation (Settings UI). */
export async function setLocationMapping(workspaceId: string, remoteLocationId: string, opsLocationId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const loc = await tx.opsLocation.findFirst({ where: { id: opsLocationId, workspaceId, active: true }, select: { id: true } });
    if (!loc) return { ok: false as const, error: "That location is not in this workspace." };
    const taken = await findLink(tx, workspaceId, P, "location", { localId: opsLocationId });
    if (taken && taken.remoteId !== remoteLocationId) return { ok: false as const, error: "That location is already mapped to another Shopify location." };
    const prior = await findLink(tx, workspaceId, P, "location", { remoteId: remoteLocationId });
    await saveLink(tx, workspaceId, P, "location", remoteLocationId, opsLocationId, { meta: (prior?.meta as Record<string, unknown>) ?? {} }, "pull");
    // Quantities agreed on for the old location no longer apply: the next
    // inventory sync treats every level at this location as a first match.
    await tx.bizSyncLink.deleteMany({ where: { workspaceId, provider: P, objectType: "inventory_level", remoteId: { endsWith: `@${remoteLocationId}` } } });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Inventory (pull)
// ---------------------------------------------------------------------------

async function localStock(tx: Tx, actor: OpsActor, productId: string, variantId: string, opsLocationId: string) {
  const qty = await onHandAt(tx, actor, productId, variantId, [opsLocationId]);
  const last = await tx.opsInventoryTxn.findFirst({
    where: { workspaceId: actor.workspaceId, variantId, locationId: opsLocationId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return { qty, at: last?.createdAt ?? new Date(0) };
}

export async function applyLevel(workspaceId: string, actor: OpsActor, lvl: ShopifyLevel, opsLocationId: string, report: SyncReport): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const itemLink = await findLink(tx, workspaceId, P, "inventory_item", { remoteId: lvl.inventoryItemId });
    const variant = itemLink ? await tx.opsProductVariant.findFirst({ where: { id: itemLink.localId, workspaceId }, select: { id: true, productId: true, sku: true } }) : null;
    if (!variant) {
      report.skipped += 1;
      return;
    }
    const product = await tx.opsProduct.findFirst({ where: { id: variant.productId, workspaceId }, select: { trackInventory: true } });
    if (!product?.trackInventory) {
      report.skipped += 1;
      return;
    }
    const remoteId = `${lvl.inventoryItemId}@${lvl.locationId}`;
    const localId = `${variant.id}@${opsLocationId}`;
    const link = await findLink(tx, workspaceId, P, "inventory_level", { remoteId });
    const lastQty = link && link.localId === localId ? qtyOf(link.meta) : null;
    const local = await localStock(tx, actor, variant.productId, variant.id, opsLocationId);
    const remoteAt = new Date(lvl.updatedAt);
    const d = decideInventory({ lastQty, remoteQty: lvl.available, localQty: local.qty, remoteAt, localAt: local.at });
    const save = (qty: number, direction: "pull" | "push" = "pull") =>
      saveLink(tx, workspaceId, P, "inventory_level", remoteId, localId, { remoteUpdatedAt: remoteAt, localUpdatedAt: local.at, meta: { qty } }, direction);
    if (d === "in_sync" || d === "skip_unchanged") {
      report.unchanged += 1;
      await save(lvl.available);
      return;
    }
    if (d === "local_ahead" || d === "conflict_local_wins") {
      if (d === "local_ahead") report.localAhead += 1;
      else report.conflicts.push({ objectType: "inventory_level", remoteId, localId, resolution: `local stock (${local.qty}) moved after Shopify's (${lvl.available}) — kept local (push it to update Shopify)` });
      if (!link || link.localId !== localId) await save(lvl.available);
      return;
    }
    if (d === "conflict_remote_wins") {
      report.conflicts.push({ objectType: "inventory_level", remoteId, localId, resolution: `Shopify (${lvl.available}) changed after local (${local.qty}) — applied Shopify's quantity` });
    }
    await recordInventoryTxn(tx, actor, {
      productId: variant.productId,
      variantId: variant.id,
      locationId: opsLocationId,
      delta: lvl.available - local.qty,
      reason: "adjustment",
      note: `Shopify inventory sync (${variant.sku}: ${local.qty} → ${lvl.available})`,
      actorName: "shopify-sync",
    });
    await save(lvl.available);
    report.updated += 1;
  });
}

export async function pullInventory(workspaceId: string, auth: ShopifyAuth, opts: { userId: string; maxPages?: number }, deps: LiveDeps = {}): Promise<SyncReport> {
  const report = emptyReport();
  const actor: OpsActor = { workspaceId, userId: opts.userId };
  const locations = await syncLocations(workspaceId, auth, actor, report, deps);
  const max = clampPages(opts.maxPages, 20);
  for (const [remoteLoc, mapped] of locations) {
    let after: string | null = null;
    let more = true;
    for (let i = 0; i < max && more; i++) {
      const page = await shopifyInventoryLevelsPage(auth, remoteLoc, after, deps);
      report.pages += 1;
      for (const node of page.nodes ?? []) {
        const lvl = levelFromGql(node, remoteLoc);
        if (lvl) await applyLevel(workspaceId, actor, lvl, mapped.opsLocationId, report);
      }
      more = Boolean(page.pageInfo?.hasNextPage);
      after = page.pageInfo?.endCursor ?? null;
    }
    if (more) report.truncated = true;
  }
  if (report.skipped > 0) report.notes.push(`${report.skipped} level(s) skipped: item not synced yet (run the catalogue sync) or product doesn't track stock.`);
  return report;
}

// ---------------------------------------------------------------------------
// Inventory (push — gated write)
// ---------------------------------------------------------------------------

export interface PushInventoryReport {
  pushed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  conflicts: Array<{ remoteId: string; localId: string; resolution: string }>;
  errors: string[];
}

export async function pushInventory(
  workspaceId: string,
  auth: ShopifyAuth,
  opts: { userId: string; productIds?: string[]; force?: boolean },
  deps: LiveDeps = {},
): Promise<PushInventoryReport> {
  const out: PushInventoryReport = { pushed: 0, unchanged: 0, skipped: 0, failed: 0, conflicts: [], errors: [] };
  const actor: OpsActor = { workspaceId, userId: opts.userId };
  const links = await withWorkspaceScope(workspaceId, (tx) => tx.bizSyncLink.findMany({ where: { workspaceId, provider: P, objectType: "inventory_level" }, orderBy: { createdAt: "asc" } }));
  const queue: Array<{ set: SetQuantity; linkRemoteId: string; localId: string; localQty: number }> = [];
  for (const link of links) {
    const [item, loc] = link.remoteId.split("@");
    const [variantId, opsLocationId] = link.localId.split("@");
    if (!item || !loc || !variantId || !opsLocationId) continue;
    const local = await withWorkspaceScope(workspaceId, async (tx) => {
      const v = await tx.opsProductVariant.findFirst({ where: { id: variantId, workspaceId }, select: { productId: true } });
      if (!v || (opts.productIds?.length && !opts.productIds.includes(v.productId))) return null;
      return localStock(tx, actor, v.productId, variantId, opsLocationId);
    });
    if (!local) continue;
    const lastQty = qtyOf(link.meta);
    if (lastQty !== null && local.qty === lastQty) {
      out.unchanged += 1;
      continue;
    }
    const current = await shopifyInventoryLevel(auth, item, loc, deps);
    if (!current) {
      out.skipped += 1;
      continue;
    }
    if (current.available === local.qty) {
      await withWorkspaceScope(workspaceId, (tx) => saveLink(tx, workspaceId, P, "inventory_level", link.remoteId, link.localId, { remoteUpdatedAt: current.updatedAt ? new Date(current.updatedAt) : null, localUpdatedAt: local.at, meta: { qty: local.qty } }, "push"));
      out.unchanged += 1;
      continue;
    }
    const remoteChanged = lastQty === null || current.available !== lastQty;
    const allowed = pushAllowedByChanges({ linked: true, remoteChanged, remoteAt: current.updatedAt ? new Date(current.updatedAt) : null, localAt: local.at, force: opts.force === true });
    if (!allowed) {
      out.conflicts.push({ remoteId: link.remoteId, localId: link.localId, resolution: `Shopify changed since the last sync (${lastQty ?? "?"} → ${current.available}) after the local move — run sync_inventory first, or push with force` });
      continue;
    }
    queue.push({ set: { inventoryItemId: item, locationId: loc, quantity: local.qty, changeFromQuantity: current.available }, linkRemoteId: link.remoteId, localId: link.localId, localQty: local.qty });
  }
  for (let i = 0; i < queue.length; i += 50) {
    const batch = queue.slice(i, i + 50);
    const key = createHash("sha256").update(`${workspaceId}:${JSON.stringify(batch.map((b) => b.set))}`).digest("hex").slice(0, 40);
    const res = await shopifySetQuantities(auth, batch.map((b) => b.set), key, deps);
    if (res.userErrors.length > 0) {
      out.failed += batch.length;
      out.errors.push(...res.userErrors.slice(0, 5).map((e) => e.message.slice(0, 200)));
      continue;
    }
    await withWorkspaceScope(workspaceId, async (tx) => {
      for (const b of batch) await saveLink(tx, workspaceId, P, "inventory_level", b.linkRemoteId, b.localId, { remoteUpdatedAt: new Date(), meta: { qty: b.localQty } }, "push");
    });
    out.pushed += batch.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orders + customers
// ---------------------------------------------------------------------------

async function variantMapFor(tx: Tx, workspaceId: string, remoteVariantIds: string[]): Promise<Map<string, { productId: string; variantId: string }>> {
  const ids = [...new Set(remoteVariantIds)];
  if (ids.length === 0) return new Map();
  const links = await tx.bizSyncLink.findMany({ where: { workspaceId, provider: P, objectType: "variant", remoteId: { in: ids } }, select: { remoteId: true, localId: true } });
  const variants = await tx.opsProductVariant.findMany({ where: { workspaceId, id: { in: links.map((l) => l.localId) } }, select: { id: true, productId: true } });
  const byId = new Map(variants.map((v) => [v.id, v.productId]));
  return new Map(links.flatMap((l) => (byId.has(l.localId) ? [[l.remoteId, { productId: byId.get(l.localId)!, variantId: l.localId }] as const] : [])));
}

const orderHash = (r: { status: string; subtotalCents: number; taxCents: number; discountCents: number; totalCents: number; lineItems: unknown; customerEmail: string | null }) =>
  fingerprint({ status: r.status, subtotalCents: r.subtotalCents, taxCents: r.taxCents, discountCents: r.discountCents, totalCents: r.totalCents, lineItems: r.lineItems, customerEmail: r.customerEmail });

export async function applyOrder(workspaceId: string, o: ShopifyOrder, report: SyncReport): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const f = orderFields(o, await variantMapFor(tx, workspaceId, o.lines.flatMap((l) => (l.variantId ? [l.variantId] : []))));
    const data = { ...f, lineItems: f.lineItems as unknown as Prisma.InputJsonValue };
    const out = await applyPulled({
      tx, workspaceId, provider: P, objectType: "order", remoteId: o.id, remoteAt: new Date(o.updatedAt), report,
      hashOf: orderHash,
      findLocal: async (link) => (link ? tx.opsOrder.findFirst({ where: { id: link.localId, workspaceId } }) : null),
      create: () => tx.opsOrder.create({ data: { workspaceId, source: "shopify", ...data, createdAt: new Date(o.createdAt) } }),
      update: (local) => tx.opsOrder.update({ where: { id: local.id, workspaceId }, data }),
      meta: { name: o.name, currency: o.currency },
    });
    const order = out.local;
    if (!order || !["created", "apply", "conflict_remote_wins"].includes(out.decision)) return;
    // Money records (provider "shopify"): one charge per paid order, refunds
    // as they grow. Records only — nothing is posted to the journal.
    if (isPaid(o) && o.totalCents > 0) {
      const prior = await tx.opsPayment.findFirst({ where: { workspaceId, provider: P, providerRef: o.id, kind: "charge" }, select: { id: true } });
      if (!prior) {
        await tx.opsPayment.create({ data: { workspaceId, orderId: order.id, provider: P, kind: "charge", amountCents: o.totalCents, status: "succeeded", providerRef: o.id, note: `Shopify order ${o.name}` } });
      }
    }
    if (o.refundedCents > 0) {
      const refunds = await tx.opsPayment.aggregate({ where: { workspaceId, provider: P, kind: "refund", providerRef: { startsWith: `${o.id}#refund` } }, _sum: { amountCents: true } });
      const booked = refunds._sum.amountCents ?? 0;
      if (o.refundedCents > booked) {
        await tx.opsPayment.create({ data: { workspaceId, orderId: order.id, provider: P, kind: "refund", amountCents: o.refundedCents - booked, status: "succeeded", providerRef: `${o.id}#refund@${o.refundedCents}`, note: `Shopify refund on ${o.name}` } });
      }
    }
  });
}

export async function pullOrders(workspaceId: string, auth: ShopifyAuth, opts: { maxPages?: number; updatedSince?: string | null }, deps: LiveDeps = {}): Promise<SyncReport> {
  const report = emptyReport();
  const since = opts.updatedSince && !Number.isNaN(Date.parse(opts.updatedSince)) ? new Date(opts.updatedSince).toISOString() : null;
  const max = clampPages(opts.maxPages, 10);
  let after: string | null = null;
  const currency = await withWorkspaceScope(workspaceId, (tx) => tx.opsFinanceSettings.findUnique({ where: { workspaceId }, select: { currency: true } }));
  const local = (currency?.currency ?? "USD").toUpperCase();
  const seen = new Set<string>();
  for (let i = 0; i < max; i++) {
    const page = await shopifyOrdersPage(auth, after, { updatedSince: since }, deps);
    report.pages += 1;
    for (const node of page.nodes ?? []) {
      const o = orderFromGql(node);
      if (o.currency && o.currency.toUpperCase() !== local) seen.add(o.currency.toUpperCase());
      await applyOrder(workspaceId, o, report);
    }
    if (!page.pageInfo?.hasNextPage) {
      after = null;
      break;
    }
    after = page.pageInfo.endCursor;
  }
  if (after) report.truncated = true;
  if (seen.size) report.notes.push(`Orders in ${[...seen].join(", ")} were imported as-is; the workspace currency is ${local} (no conversion).`);
  return report;
}

const contactHash = (r: { name: string; email: string | null; phone: string | null }) => fingerprint({ name: r.name, email: r.email, phone: r.phone });

export async function applyCustomer(workspaceId: string, c: ShopifyCustomer, report: SyncReport): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const email = normalizeEmail(c.email);
    const f = { name: c.name, email, phone: c.phone };
    await applyPulled({
      tx, workspaceId, provider: P, objectType: "customer", remoteId: c.id, remoteAt: new Date(c.updatedAt), report,
      hashOf: contactHash,
      findLocal: async (link) =>
        link ? tx.opsContact.findFirst({ where: { id: link.localId, workspaceId } }) : email ? tx.opsContact.findFirst({ where: { workspaceId, email } }) : null,
      create: () => tx.opsContact.create({ data: { workspaceId, ...f } }),
      update: async (local) => {
        // An empty Shopify value never erases a local one; a unique clash keeps the local email.
        const data: Partial<typeof f> = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null));
        if (data.email && (await tx.opsContact.findFirst({ where: { workspaceId, email: data.email, NOT: { id: local.id } }, select: { id: true } }))) {
          report.conflicts.push({ objectType: "customer", remoteId: c.id, localId: local.id, resolution: "email used by another local contact; kept the local email" });
          delete data.email;
        }
        return tx.opsContact.update({ where: { id: local.id, workspaceId }, data });
      },
    });
  });
}

export async function pullCustomers(workspaceId: string, auth: ShopifyAuth, opts: { maxPages?: number }, deps: LiveDeps = {}): Promise<SyncReport> {
  const report = emptyReport();
  const max = clampPages(opts.maxPages, 20);
  let after: string | null = null;
  for (let i = 0; i < max; i++) {
    const page = await shopifyCustomersPage(auth, after, deps);
    report.pages += 1;
    for (const node of page.nodes ?? []) await applyCustomer(workspaceId, customerFromGql(node), report);
    if (!page.pageInfo?.hasNextPage) return report;
    after = page.pageInfo.endCursor;
  }
  report.truncated = true;
  return report;
}

// ---------------------------------------------------------------------------
// Signed webhooks (verified by the Tier-W ingest route first)
// ---------------------------------------------------------------------------

export const SHOPIFY_WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "INVENTORY_LEVELS_UPDATE",
] as const;

/** Whether this verified webhook topic is applied to Ops (else only the graph ingest sees it). */
export function isOpsTopic(topic: string): boolean {
  return /^(orders\/(create|updated|paid|cancelled|fulfilled)|products\/(create|update)|customers\/(create|update)|inventory_levels\/update)$/.test(topic);
}

export async function applyShopifyWebhook(workspaceId: string, topic: string, body: Record<string, unknown>): Promise<{ applied: boolean; detail: string; report?: SyncReport }> {
  if (!isOpsTopic(topic)) return { applied: false, detail: `topic ${topic || "(none)"} is not synced to Ops` };
  const installed = await prisma.connectorConnection.findFirst({ where: { workspaceId, connectorKey: P, status: "active" }, select: { id: true } });
  if (!installed) return { applied: false, detail: "Shopify app is not connected in this workspace — nothing applied to Ops" };
  try {
    return await applyWebhookTopic(workspaceId, topic, body);
  } catch (err) {
    // Webhooks have no caller to report to: the failure goes to the run log
    // (Settings → Connectors → Business sync) and the route's response.
    await recordFailedRun(workspaceId, P, `webhook ${topic}`, "webhook:shopify", err);
    throw err;
  }
}

async function applyWebhookTopic(workspaceId: string, topic: string, body: Record<string, unknown>): Promise<{ applied: boolean; detail: string; report?: SyncReport }> {
  const report = emptyReport();
  const actor: OpsActor = { workspaceId, userId: "shopify-webhook" };
  if (topic.startsWith("orders/")) {
    const o = orderFromRest(body);
    if (!o) return { applied: false, detail: "order payload has no id" };
    await applyOrder(workspaceId, o, report);
  } else if (topic.startsWith("products/")) {
    const p = productFromRest(body);
    if (!p) return { applied: false, detail: "product payload has no id" };
    await applyProduct(workspaceId, p, report, actor);
  } else if (topic.startsWith("customers/")) {
    const c = customerFromRest(body);
    if (!c) return { applied: false, detail: "customer payload has no id" };
    await applyCustomer(workspaceId, c, report);
  } else {
    const lvl = levelFromRest(body);
    if (!lvl) return { applied: false, detail: "inventory payload has no item/location" };
    const loc = await withWorkspaceScope(workspaceId, (tx) => findLink(tx, workspaceId, P, "location", { remoteId: lvl.locationId }));
    if (!loc) return { applied: false, detail: "Shopify location is not mapped yet (run sync_inventory once)" };
    await applyLevel(workspaceId, actor, lvl, loc.localId, report);
  }
  return { applied: true, detail: `${topic}: ${report.created} created, ${report.updated} updated, ${report.unchanged} unchanged, ${report.conflicts.length} conflict(s)`, report };
}

export async function registerShopifyWebhooks(
  workspaceId: string,
  auth: ShopifyAuth,
  baseUrl: string,
  deps: LiveDeps = {},
): Promise<{ uri: string; created: string[]; existing: string[]; errors: string[] }> {
  const uri = `${baseUrl.replace(/\/+$/, "")}/api/substrate/graph/webhooks/shopify?workspaceId=${encodeURIComponent(workspaceId)}`;
  const current = await shopifyWebhookSubscriptions(auth, deps);
  const out = { uri, created: [] as string[], existing: [] as string[], errors: [] as string[] };
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    if (current.some((s) => s.topic === topic && s.uri === uri)) {
      out.existing.push(topic);
      continue;
    }
    const res = await shopifyCreateWebhook(auth, topic, uri, deps);
    if (res.userErrors.length) out.errors.push(`${topic}: ${res.userErrors[0]!.message.slice(0, 160)}`);
    else out.created.push(topic);
  }
  return out;
}
