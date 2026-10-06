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
  openTickets: number;
  breachedTickets: number;
  openTasks: number;
}

type Tx = Prisma.TransactionClient;

/** Net payments: refunds subtract, every other kind adds (the same rule as before, on per-kind sums). PURE. */
export function paymentsNetCents(sums: ReadonlyArray<{ kind: string; sumCents: number }>): number {
  return sums.reduce((s, p) => s + (p.kind === "refund" ? -p.sumCents : p.sumCents), 0);
}

export async function getOpsOverview(tx: Tx, workspaceId: string): Promise<OpsOverview> {
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const active = { in: ["new", "open", "pending"] as Array<"new" | "open" | "pending"> };
  const [summary, openOrders, activeProjects, payments, openTickets, breachedTickets, openTasks] = await Promise.all([
    getOpsSummary(tx as unknown as OpsSummaryTx, workspaceId),
    tx.opsOrder.count({ where: { workspaceId, status: { in: ["draft", "confirmed"] } } }),
    tx.opsProject.count({ where: { workspaceId, status: { in: ["planning", "active"] } } }),
    // Phase 17 (latency): one SQL aggregate per payment kind instead of
    // fetching the rows (the old read also stopped at 5,000 rows, so a busy
    // month was under-counted).
    tx.opsPayment.groupBy({
      by: ["kind"],
      where: { workspaceId, status: "succeeded", createdAt: { gte: since } },
      _sum: { amountCents: true },
    }),
    tx.opsTicket.count({ where: { workspaceId, status: active } }),
    tx.opsTicket.count({ where: { workspaceId, status: active, slaBreachedAt: { not: null } } }),
    tx.opsTask.count({ where: { workspaceId, stage: { notIn: ["done", "cancelled"] } } }),
  ]);
  const paymentsLast30dCents = paymentsNetCents(payments.map((p) => ({ kind: p.kind, sumCents: p._sum.amountCents ?? 0 })));
  return { ...summary, openOrders, activeProjects, paymentsLast30dCents, openTickets, breachedTickets, openTasks };
}
