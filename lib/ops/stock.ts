// ShapesOS Phase 10 (ops-core) — warehouses, locations, variants, per-
// location stock, transfers and reorder rules.
//
// Built ON the Phase 17 DocType convention: every entity here is registered
// in OPS_ENTITIES (lib/ops/entities.ts) so the generic /api/ops/{entity}
// route, audit rows and workspace scoping apply; these functions are the
// entity-specific create/patch hooks plus read helpers.
//
// Ledger law (unchanged): stock only moves through recordInventoryTxn
// (lib/ops/doctype.ts) — one immutable txn row + the product's stockQty
// total in the same transaction. Per-location / per-variant quantities
// ("quants") are DERIVED from the ledger (Σ delta grouped by product,
// variant, location) — there is no second balance to drift.
//
// Phase 13 (digital twin) binds racks/bins/docks to OpsLocation ids, so
// the hierarchy rules below are strict and codes are immutable.

import type { Prisma } from "@prisma/client";
import { OpsError, OpsNotFoundError, auditOpsEvent, recordInventoryTxn, type OpsActor } from "./doctype";
import { OPS_ENTITY_MAP } from "./entities";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Location hierarchy (pure)
// ---------------------------------------------------------------------------

export const LOCATION_KINDS = ["zone", "aisle", "rack", "shelf", "bin", "dock"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** Depth rank: a child's rank must be strictly greater than its parent's. */
export const LOCATION_KIND_RANK: Record<LocationKind, number> = {
  zone: 1,
  dock: 1,
  aisle: 2,
  rack: 3,
  shelf: 4,
  bin: 5,
};

/** Kinds that can never hold child locations. */
const LEAF_KINDS: LocationKind[] = ["bin", "dock"];

/**
 * Validate a parent → child kind pair (parent null = directly under the
 * warehouse). Docks live under the warehouse or a zone; bins and docks are
 * leaves; depth only ever increases (zone → aisle → rack → shelf → bin, with
 * levels skippable).
 */
export function assertLocationParent(parentKind: LocationKind | null, childKind: LocationKind): void {
  if (!LOCATION_KINDS.includes(childKind)) throw new OpsError(400, `Unknown location kind "${childKind}"`);
  if (parentKind === null) return;
  if (LEAF_KINDS.includes(parentKind)) {
    throw new OpsError(422, `A ${parentKind} cannot contain other locations`);
  }
  if (childKind === "dock") {
    if (parentKind !== "zone") throw new OpsError(422, "A dock sits directly under the warehouse or under a zone");
    return;
  }
  if (LOCATION_KIND_RANK[childKind] <= LOCATION_KIND_RANK[parentKind]) {
    throw new OpsError(422, `A ${childKind} cannot sit inside a ${parentKind} (warehouse → zone → aisle → rack → shelf → bin)`);
  }
}

export function locationPath(warehouseCode: string, parentPath: string | null, code: string): string {
  return `${parentPath ?? warehouseCode}/${code}`;
}

// ---------------------------------------------------------------------------
// Quants: per-location stock derived from the ledger (pure)
// ---------------------------------------------------------------------------

export interface LedgerRow {
  productId: string;
  variantId: string | null;
  locationId: string | null;
  delta: number;
}

export interface Quant {
  productId: string;
  variantId: string | null;
  locationId: string | null;
  qty: number;
}

const quantKey = (r: { productId: string; variantId: string | null; locationId: string | null }) =>
  `${r.productId}|${r.variantId ?? ""}|${r.locationId ?? ""}`;

/**
 * Fold ledger rows into quants. `defaultVariantOf` maps a product to its
 * default variant so legacy rows with no variant land on it. Zero quants
 * are dropped (fully moved-out stock disappears from the report).
 */
export function deriveQuants(rows: LedgerRow[], defaultVariantOf: (productId: string) => string | null = () => null): Quant[] {
  const acc = new Map<string, Quant>();
  for (const r of rows) {
    const variantId = r.variantId ?? defaultVariantOf(r.productId);
    const q = { productId: r.productId, variantId, locationId: r.locationId, qty: 0 };
    const k = quantKey(q);
    const cur = acc.get(k) ?? q;
    cur.qty += r.delta;
    acc.set(k, cur);
  }
  return [...acc.values()].filter((q) => q.qty !== 0);
}

// ---------------------------------------------------------------------------
// Delegates (structural so tests can pass a stub tx)
// ---------------------------------------------------------------------------

interface D {
  findFirst(a: unknown): Promise<Record<string, unknown> | null>;
  findMany(a: unknown): Promise<Array<Record<string, unknown>>>;
  create(a: unknown): Promise<Record<string, unknown>>;
  update(a: unknown): Promise<Record<string, unknown>>;
  updateMany(a: unknown): Promise<{ count: number }>;
  upsert(a: unknown): Promise<Record<string, unknown>>;
  groupBy(a: unknown): Promise<Array<Record<string, unknown>>>;
}

function del(tx: Tx, name: string): D {
  return (tx as unknown as Record<string, D>)[name];
}

async function mustFind(tx: Tx, delegate: string, slug: string, id: string, workspaceId: string) {
  const row = await del(tx, delegate).findFirst({ where: { id, workspaceId } });
  if (!row) throw new OpsNotFoundError(slug, id);
  return row;
}

// ---------------------------------------------------------------------------
// Create / patch hooks (wired from OPS_ENTITIES)
// ---------------------------------------------------------------------------

export async function createLocationRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  const warehouse = await mustFind(tx, "opsWarehouse", "warehouses", String(body.warehouseId), actor.workspaceId);
  const kind = body.kind as LocationKind;
  let parent: Record<string, unknown> | null = null;
  if (typeof body.parentId === "string" && body.parentId) {
    parent = await mustFind(tx, "opsLocation", "locations", body.parentId, actor.workspaceId);
    if (parent.warehouseId !== warehouse.id) {
      throw new OpsError(422, "The parent location belongs to a different warehouse");
    }
  }
  assertLocationParent((parent?.kind as LocationKind | undefined) ?? null, kind);
  const code = String(body.code).trim();
  return del(tx, "opsLocation").create({
    data: {
      workspaceId: actor.workspaceId,
      warehouseId: warehouse.id,
      parentId: parent ? parent.id : null,
      kind,
      code,
      name: (body.name as string | undefined) ?? null,
      path: locationPath(String(warehouse.code), (parent?.path as string | undefined) ?? null, code),
    },
  });
}

/** Deterministic default-variant id — matches the migration backfill. */
export function defaultVariantId(productId: string): string {
  return `pvd_${productId}`;
}

/** The product's default (single) variant, created on first use. Idempotent. */
export async function ensureDefaultVariant(tx: Tx, actor: OpsActor, productId: string): Promise<Record<string, unknown>> {
  const id = defaultVariantId(productId);
  const variants = del(tx, "opsProductVariant");
  const existing = await variants.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (existing) return existing;
  const product = await mustFind(tx, "opsProduct", "products", productId, actor.workspaceId);
  const create = { id, workspaceId: actor.workspaceId, productId, sku: product.sku, name: product.name, isDefault: true };
  // upsert on the deterministic id: a concurrent first move resolves to the
  // same row (structural stubs without upsert fall back to create).
  return typeof variants.upsert === "function"
    ? variants.upsert({ where: { id }, create, update: {} })
    : variants.create({ data: create });
}

export async function createVariantRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  const productId = String(body.productId);
  // Materialize the default first so the product's existing stock keeps a
  // variant to live on once it has several.
  await ensureDefaultVariant(tx, actor, productId);
  return del(tx, "opsProductVariant").create({
    data: {
      workspaceId: actor.workspaceId,
      productId,
      sku: String(body.sku).trim(),
      name: String(body.name).trim(),
      attributes: (body.attributes as Record<string, string> | undefined) ?? {},
      priceCents: (body.priceCents as number | undefined) ?? null,
      isDefault: false,
    },
  });
}

/**
 * Resolve where a stock move lands: the variant (default variant when
 * omitted) and an optional location — both must belong to the workspace
 * and the variant to the product. Used by recordInventoryTxn.
 */
export async function resolveStockTarget(
  tx: Tx,
  actor: OpsActor,
  productId: string,
  variantId: string | null | undefined,
  locationId: string | null | undefined,
): Promise<{ variantId: string; locationId: string | null }> {
  let vid: string;
  if (variantId) {
    const v = await mustFind(tx, "opsProductVariant", "product-variants", variantId, actor.workspaceId);
    if (v.productId !== productId) throw new OpsError(422, `Variant "${variantId}" is not a variant of product "${productId}"`);
    vid = variantId;
  } else {
    vid = String((await ensureDefaultVariant(tx, actor, productId)).id);
  }
  if (locationId) await mustFind(tx, "opsLocation", "locations", locationId, actor.workspaceId);
  return { variantId: vid, locationId: locationId ?? null };
}

// ---------------------------------------------------------------------------
// Stock by location (read)
// ---------------------------------------------------------------------------

export interface StockRow {
  productId: string;
  productName: string;
  sku: string;
  variantId: string | null;
  variantName: string | null;
  variantSku: string | null;
  locationId: string | null;
  locationPath: string | null;
  warehouseId: string | null;
  qty: number;
}

export async function stockByLocation(
  tx: Tx,
  actor: OpsActor,
  filter: { warehouseId?: string; productId?: string; locationId?: string } = {},
): Promise<StockRow[]> {
  let locationIds: string[] | undefined;
  if (filter.warehouseId) {
    const locs = await del(tx, "opsLocation").findMany({
      where: { workspaceId: actor.workspaceId, warehouseId: filter.warehouseId },
      select: { id: true },
    });
    locationIds = locs.map((l) => String(l.id));
  }
  if (filter.locationId) locationIds = [filter.locationId];
  const groups = await del(tx, "opsInventoryTxn").groupBy({
    by: ["productId", "variantId", "locationId"],
    where: {
      workspaceId: actor.workspaceId,
      ...(filter.productId ? { productId: filter.productId } : {}),
      ...(locationIds ? { locationId: { in: locationIds } } : {}),
    },
    _sum: { delta: true },
  });
  const quants = deriveQuants(
    groups.map((g) => ({
      productId: String(g.productId),
      variantId: (g.variantId as string | null) ?? null,
      locationId: (g.locationId as string | null) ?? null,
      delta: Number((g._sum as { delta: number | null }).delta ?? 0),
    })),
    (pid) => defaultVariantId(pid),
  );
  if (quants.length === 0) return [];
  const [products, variants, locations] = await Promise.all([
    del(tx, "opsProduct").findMany({ where: { workspaceId: actor.workspaceId, id: { in: [...new Set(quants.map((q) => q.productId))] } } }),
    del(tx, "opsProductVariant").findMany({
      where: { workspaceId: actor.workspaceId, id: { in: [...new Set(quants.map((q) => q.variantId).filter(Boolean))] } },
    }),
    del(tx, "opsLocation").findMany({
      where: { workspaceId: actor.workspaceId, id: { in: [...new Set(quants.map((q) => q.locationId).filter(Boolean))] } },
    }),
  ]);
  const P = new Map(products.map((p) => [String(p.id), p]));
  const V = new Map(variants.map((v) => [String(v.id), v]));
  const L = new Map(locations.map((l) => [String(l.id), l]));
  return quants
    .map((q) => {
      const p = P.get(q.productId);
      const v = q.variantId ? V.get(q.variantId) : undefined;
      const l = q.locationId ? L.get(q.locationId) : undefined;
      return {
        productId: q.productId,
        productName: String(p?.name ?? q.productId),
        sku: String(p?.sku ?? ""),
        variantId: q.variantId,
        variantName: v ? String(v.name) : null,
        variantSku: v ? String(v.sku) : null,
        locationId: q.locationId,
        locationPath: l ? String(l.path) : null,
        warehouseId: l ? String(l.warehouseId) : null,
        qty: q.qty,
      };
    })
    .sort((a, b) => (a.locationPath ?? "~").localeCompare(b.locationPath ?? "~") || a.productName.localeCompare(b.productName));
}

/** On-hand quantity of one product (+variant) at a set of locations. */
export async function onHandAt(
  tx: Tx,
  actor: OpsActor,
  productId: string,
  variantId: string | null,
  locationIds: string[],
): Promise<number> {
  if (locationIds.length === 0) return 0;
  const groups = await del(tx, "opsInventoryTxn").groupBy({
    by: ["variantId"],
    where: { workspaceId: actor.workspaceId, productId, locationId: { in: locationIds } },
    _sum: { delta: true },
  });
  const dv = defaultVariantId(productId);
  return groups
    .filter((g) => variantId === null || ((g.variantId as string | null) ?? dv) === variantId)
    .reduce((s, g) => s + Number((g._sum as { delta: number | null }).delta ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export interface TransferLine {
  productId: string;
  variantId?: string;
  qty: number;
}

export async function createTransferRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  const from = String(body.fromLocationId);
  const to = String(body.toLocationId);
  if (from === to) throw new OpsError(422, "A transfer needs two different locations");
  await mustFind(tx, "opsLocation", "locations", from, actor.workspaceId);
  await mustFind(tx, "opsLocation", "locations", to, actor.workspaceId);
  const lines = body.lines as TransferLine[];
  const resolved: TransferLine[] = [];
  for (const l of lines) {
    const { variantId } = await resolveStockTarget(tx, actor, l.productId, l.variantId ?? null, null);
    resolved.push({ productId: l.productId, variantId, qty: l.qty });
  }
  return del(tx, "opsTransfer").create({
    data: {
      workspaceId: actor.workspaceId,
      fromLocationId: from,
      toLocationId: to,
      lines: resolved as unknown as Prisma.InputJsonValue,
      status: "draft",
      note: (body.note as string | undefined) ?? null,
      createdBy: actor.userId,
    },
  });
}

/**
 * Book a draft transfer: claim draft → done (status-guarded, so a double
 * submit books once), check the source holds enough of every line, then
 * write a paired −qty/+qty ledger txn per line. Product totals are
 * unchanged by construction (the two legs net to zero).
 */
export async function completeTransfer(tx: Tx, actor: OpsActor, id: string): Promise<Record<string, unknown>> {
  const t = await mustFind(tx, "opsTransfer", "transfers", id, actor.workspaceId);
  const claimed = await del(tx, "opsTransfer").updateMany({
    where: { id, workspaceId: actor.workspaceId, status: "draft" },
    data: { status: "done", doneAt: new Date() },
  });
  if (claimed.count !== 1) throw new OpsError(409, `Transfer ${id} is no longer a draft`);
  const lines = (t.lines ?? []) as TransferLine[];
  // Availability per (product, variant) at the source — summed across lines.
  const need = new Map<string, { productId: string; variantId: string | null; qty: number }>();
  for (const l of lines) {
    const k = `${l.productId}|${l.variantId ?? ""}`;
    const cur = need.get(k) ?? { productId: l.productId, variantId: l.variantId ?? null, qty: 0 };
    cur.qty += l.qty;
    need.set(k, cur);
  }
  for (const n of need.values()) {
    const have = await onHandAt(tx, actor, n.productId, n.variantId, [String(t.fromLocationId)]);
    if (have < n.qty) {
      throw new OpsError(409, `Not enough stock at the source: ${n.qty} needed, ${have} on hand (product ${n.productId})`);
    }
  }
  for (const l of lines) {
    const base = { productId: l.productId, variantId: l.variantId ?? null, reason: "transfer" as const, transferId: id, note: `transfer ${id}` };
    await recordInventoryTxn(tx, actor, { ...base, delta: -l.qty, locationId: String(t.fromLocationId) });
    await recordInventoryTxn(tx, actor, { ...base, delta: l.qty, locationId: String(t.toLocationId) });
  }
  return (await del(tx, "opsTransfer").findFirst({ where: { id, workspaceId: actor.workspaceId } }))!;
}

export async function patchTransfer(
  tx: Tx,
  actor: OpsActor,
  id: string,
  patch: Record<string, unknown>,
  existing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (patch.status === "done") return completeTransfer(tx, actor, id);
  const claimed = await del(tx, "opsTransfer").updateMany({
    where: { id, workspaceId: actor.workspaceId, status: existing.status },
    data: { ...patch },
  });
  if (claimed.count !== 1) throw new OpsError(409, "Transfer changed concurrently — reload and retry");
  return (await del(tx, "opsTransfer").findFirst({ where: { id, workspaceId: actor.workspaceId } }))!;
}

// ---------------------------------------------------------------------------
// Reorder rules
// ---------------------------------------------------------------------------

export function assertMinMax(minQty: number, maxQty: number): void {
  if (!Number.isInteger(minQty) || !Number.isInteger(maxQty) || minQty < 0 || maxQty <= minQty) {
    throw new OpsError(422, "Reorder rule needs whole numbers with max greater than min (min ≥ 0)");
  }
}

export async function createReorderRuleRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  assertMinMax(body.minQty as number, body.maxQty as number);
  const productId = String(body.productId);
  const warehouse = await mustFind(tx, "opsWarehouse", "warehouses", String(body.warehouseId), actor.workspaceId);
  const product = await mustFind(tx, "opsProduct", "products", productId, actor.workspaceId);
  if (!product.trackInventory) throw new OpsError(422, "This product does not track inventory");
  let variantId: string | null = null;
  if (typeof body.variantId === "string" && body.variantId) {
    variantId = (await resolveStockTarget(tx, actor, productId, body.variantId, null)).variantId;
  }
  let receiveLocationId: string | null = null;
  if (typeof body.receiveLocationId === "string" && body.receiveLocationId) {
    const loc = await mustFind(tx, "opsLocation", "locations", body.receiveLocationId, actor.workspaceId);
    if (loc.warehouseId !== warehouse.id) throw new OpsError(422, "The receiving location must be inside the rule's warehouse");
    receiveLocationId = String(loc.id);
  }
  return del(tx, "opsReorderRule").create({
    data: {
      workspaceId: actor.workspaceId,
      productId,
      variantId,
      warehouseId: warehouse.id,
      receiveLocationId,
      minQty: body.minQty,
      maxQty: body.maxQty,
      supplierName: (body.supplierName as string | undefined) ?? null,
      unitCostCents: (body.unitCostCents as number | undefined) ?? null,
    },
  });
}

export async function patchReorderRule(
  tx: Tx,
  actor: OpsActor,
  id: string,
  patch: Record<string, unknown>,
  existing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const minQty = (patch.minQty as number | undefined) ?? Number(existing.minQty);
  const maxQty = (patch.maxQty as number | undefined) ?? Number(existing.maxQty);
  assertMinMax(minQty, maxQty);
  if (typeof patch.receiveLocationId === "string") {
    const loc = await mustFind(tx, "opsLocation", "locations", patch.receiveLocationId, actor.workspaceId);
    if (loc.warehouseId !== existing.warehouseId) throw new OpsError(422, "The receiving location must be inside the rule's warehouse");
  }
  return del(tx, "opsReorderRule").update({ where: { id, workspaceId: actor.workspaceId }, data: { ...patch } });
}

export type ReorderPlan =
  | { action: "draft"; qty: number }
  | { action: "skip"; reason: "above_min" | "open_po" | "inactive" };

/**
 * Pure decision for one rule. A breach (on-hand ≤ min) drafts a PO for
 * max − on-hand — unless the rule's previous draft/sent PO is still open
 * (one draft per breach; the PO closing re-arms the rule).
 */
export function planReorder(
  rule: { minQty: number; maxQty: number; active: boolean },
  onHand: number,
  openPoStatus: string | null,
): ReorderPlan {
  if (!rule.active) return { action: "skip", reason: "inactive" };
  if (openPoStatus === "draft" || openPoStatus === "sent") return { action: "skip", reason: "open_po" };
  if (onHand > rule.minQty) return { action: "skip", reason: "above_min" };
  return { action: "draft", qty: Math.max(1, rule.maxQty - onHand) };
}

export interface ReorderSweepResult {
  checked: number;
  drafted: Array<{ ruleId: string; purchaseOrderId: string; qty: number }>;
  skipped: number;
}

/**
 * Sweep one workspace's active rules (caller scopes with
 * withWorkspaceScope). Drafts only — sending the PO stays a gated write.
 */
export async function runReorderSweep(tx: Tx, actor: OpsActor): Promise<ReorderSweepResult> {
  const rules = await del(tx, "opsReorderRule").findMany({
    where: { workspaceId: actor.workspaceId, active: true },
    take: 1000,
  });
  const out: ReorderSweepResult = { checked: rules.length, drafted: [], skipped: 0 };
  const poDef = OPS_ENTITY_MAP["purchase-orders"];
  for (const r of rules) {
    const locs = await del(tx, "opsLocation").findMany({
      where: { workspaceId: actor.workspaceId, warehouseId: r.warehouseId },
      select: { id: true },
    });
    const onHand = await onHandAt(tx, actor, String(r.productId), (r.variantId as string | null) ?? null, locs.map((l) => String(l.id)));
    let openStatus: string | null = null;
    if (r.openPurchaseOrderId) {
      const po = await del(tx, "opsPurchaseOrder").findFirst({ where: { id: r.openPurchaseOrderId, workspaceId: actor.workspaceId } });
      openStatus = po ? String(po.status) : null;
    }
    const plan = planReorder(
      { minQty: Number(r.minQty), maxQty: Number(r.maxQty), active: Boolean(r.active) },
      onHand,
      openStatus,
    );
    if (plan.action === "skip") {
      out.skipped += 1;
      continue;
    }
    const product = await mustFind(tx, "opsProduct", "products", String(r.productId), actor.workspaceId);
    const unit = r.unitCostCents == null ? 0 : Number(r.unitCostCents);
    const line = {
      productId: String(r.productId),
      ...(r.variantId ? { variantId: String(r.variantId) } : {}),
      ...(r.receiveLocationId ? { locationId: String(r.receiveLocationId) } : {}),
      name: String(product.name),
      sku: String(product.sku),
      qty: plan.qty,
      priceCents: unit,
    };
    // Claim the rule first (guarded on the PO id we saw) so two concurrent
    // sweeps can't both draft for the same breach.
    const claim = await del(tx, "opsReorderRule").updateMany({
      where: { id: r.id, workspaceId: actor.workspaceId, openPurchaseOrderId: r.openPurchaseOrderId ?? null },
      data: { lastTriggeredAt: new Date() },
    });
    if (claim.count !== 1) {
      out.skipped += 1;
      continue;
    }
    const po = await del(tx, "opsPurchaseOrder").create({
      data: {
        workspaceId: actor.workspaceId,
        status: "draft",
        supplierName: (r.supplierName as string | null) ?? null,
        lineItems: [line] as unknown as Prisma.InputJsonValue,
        taxCents: 0,
        subtotalCents: plan.qty * unit,
        totalCents: plan.qty * unit,
      },
    });
    await del(tx, "opsReorderRule").update({ where: { id: String(r.id), workspaceId: actor.workspaceId }, data: { openPurchaseOrderId: po.id } });
    await auditOpsEvent(tx, poDef, actor, "create", String(po.id), `reorder rule ${String(r.id)} drafted purchase order ${String(po.id)} for ${plan.qty} × ${String(product.sku)} (on hand ${onHand} ≤ min ${String(r.minQty)})`);
    out.drafted.push({ ruleId: String(r.id), purchaseOrderId: String(po.id), qty: plan.qty });
  }
  return out;
}
