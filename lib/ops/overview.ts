// ShapesOS Phase 10 (ops-core) — the /dashboard/ops overview numbers.
//
// Extends (never duplicates) getOpsSummary (lib/ops/summary.ts, the agent's
// pulse): the overview adds order, project and payment counts. Tx-based so
// the caller scopes it with withWorkspaceScope (FORCE RLS) and tests can
// pass a stub.

import type { Prisma } from "@prisma/client";
import { getOpsSummary, type OpsSummary, type OpsSummaryTx } from "./summary";

export interface OpsOverview extends OpsSummary {
  openOrders: number;
  activeProjects: number;
  paymentsLast30dCents: number;
}

type Tx = Prisma.TransactionClient;

export async function getOpsOverview(tx: Tx, workspaceId: string): Promise<OpsOverview> {
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const [summary, openOrders, activeProjects, payments] = await Promise.all([
    getOpsSummary(tx as unknown as OpsSummaryTx, workspaceId),
    tx.opsOrder.count({ where: { workspaceId, status: { in: ["draft", "confirmed"] } } }),
    tx.opsProject.count({ where: { workspaceId, status: { in: ["planning", "active"] } } }),
    tx.opsPayment.findMany({
      where: { workspaceId, status: "succeeded", createdAt: { gte: since } },
      select: { kind: true, amountCents: true },
      take: 5000,
    }),
  ]);
  const paymentsLast30dCents = payments.reduce((s, p) => s + (p.kind === "refund" ? -p.amountCents : p.amountCents), 0);
  return { ...summary, openOrders, activeProjects, paymentsLast30dCents };
}
