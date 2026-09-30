// Marketr — Phase 17 slice 7: Operations summary for the agent surface.
//
// One bounded query per concern: open invoices, overdue invoices, low-stock
// products, and pending ops approvals. Consumed by BOTH the agent's
// ops_operations_summary tool (lib/chat/ops-tools.ts) and the CoAgents
// shared-state loader (lib/agents/agui/shared-state-db.ts) — single source,
// never duplicated.
//
// Tx-based (not prisma-direct) so RLS scoping is the caller's job via
// withWorkspaceScope, and so node:test can pass a stub tx.

export interface OpsSummary {
  openInvoices: number;
  overdueInvoices: number;
  lowStockCount: number;
  pendingOpsApprovals: number;
}

interface CountDelegate {
  count(args: unknown): Promise<number>;
}

interface ProductRow {
  stockQty: number;
  lowStockThreshold: number;
  trackInventory: boolean;
}

/** Structural tx — mirrors the Delegate pattern in lib/ops/doctype.ts. */
export interface OpsSummaryTx {
  opsInvoice: CountDelegate;
  opsProduct: { findMany(args: unknown): Promise<ProductRow[]> };
  composioActionApproval: CountDelegate;
}

/**
 * Load the operations summary for a workspace. All counts are
 * workspace-scoped by construction (the caller runs inside
 * withWorkspaceScope; the tables are FORCE RLS).
 */
export async function getOpsSummary(
  tx: OpsSummaryTx,
  workspaceId: string,
): Promise<OpsSummary> {
  const [openInvoices, overdueInvoices, products, pendingOpsApprovals] =
    await Promise.all([
      tx.opsInvoice.count({
        where: { workspaceId, status: { in: ["draft", "sent"] } },
      }),
      tx.opsInvoice.count({ where: { workspaceId, status: "overdue" } }),
      // Low-stock compares two columns (stockQty <= lowStockThreshold), so
      // it is computed in JS over a bounded tracked-product list.
      tx.opsProduct.findMany({
        where: { workspaceId, trackInventory: true },
        select: { stockQty: true, lowStockThreshold: true, trackInventory: true },
        take: 500,
      }),
      tx.composioActionApproval.count({
        where: { workspaceId, appKey: "ops", status: "pending" },
      }),
    ]);

  const lowStockCount = products.filter(
    (p) => p.trackInventory && p.stockQty <= p.lowStockThreshold,
  ).length;

  return { openInvoices, overdueInvoices, lowStockCount, pendingOpsApprovals };
}
