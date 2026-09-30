// Marketr — Phase 17 slice 3: inventory-specific service layer.
//
// Built ON TOP of the slice-1 DocType convention (lib/ops/doctype.ts):
//   - low-stock alerts: a product alerts when it tracks inventory AND
//     stockQty <= lowStockThreshold. Surfaced explicitly via
//     GET /api/ops/inventory/low-stock (computed on read, like the invoice
//     overdue sweep — no cron yet).
//   - stock history: per-product inventory-txn ledger through the generic
//     route (/api/ops/inventory-txns?productId=…).
//
// Stock moves themselves flow through the generic inventory-txns create
// (atomic txn + balance via recordInventoryTxn in doctype.ts) — there is
// no second write path.

import type { Prisma } from "@prisma/client";
import {
  OpsNotFoundError,
  type OpsActor,
} from "./doctype";

type Tx = Prisma.TransactionClient;

export interface OpsProductRow {
  id: string;
  workspaceId: string;
  name: string;
  sku: string;
  priceCents: number;
  stockQty: number;
  trackInventory: boolean;
  lowStockThreshold: number;
  createdAt: Date | string;
  [key: string]: unknown;
}

export interface OpsInventoryTxnRow {
  id: string;
  workspaceId: string;
  productId: string;
  delta: number;
  reason: string;
  actor: string | null;
  note: string | null;
  createdAt: Date | string;
  [key: string]: unknown;
}

/** A product is low-stock when it tracks inventory and is at/below threshold. */
export function isLowStock(p: Pick<OpsProductRow, "trackInventory" | "stockQty" | "lowStockThreshold">): boolean {
  return p.trackInventory && p.stockQty <= p.lowStockThreshold;
}

/**
 * Low-stock alert list for the workspace. Prisma cannot compare two
 * columns in a where clause, so the filter runs in JS over the product
 * list (bounded take — catalogs are small).
 */
export async function lowStockProducts(
  tx: Tx,
  actor: OpsActor,
): Promise<OpsProductRow[]> {
  const rows = (await (
    tx as unknown as {
      opsProduct: { findMany(a: unknown): Promise<OpsProductRow[]> };
    }
  ).opsProduct.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { name: "asc" },
    take: 500,
  })) as OpsProductRow[];
  return rows.filter(isLowStock);
}

/** Per-product stock history (the inventory-txn ledger), workspace-scoped. */
export async function getProductHistory(
  tx: Tx,
  actor: OpsActor,
  productId: string,
): Promise<{ product: OpsProductRow; txns: OpsInventoryTxnRow[] }> {
  const delegates = tx as unknown as {
    opsProduct: { findFirst(a: unknown): Promise<OpsProductRow | null> };
    opsInventoryTxn: { findMany(a: unknown): Promise<OpsInventoryTxnRow[]> };
  };
  const product = await delegates.opsProduct.findFirst({
    where: { id: productId, workspaceId: actor.workspaceId },
  });
  if (!product) throw new OpsNotFoundError("products", productId);
  const txns = await delegates.opsInventoryTxn.findMany({
    where: { workspaceId: actor.workspaceId, productId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return { product, txns };
}
