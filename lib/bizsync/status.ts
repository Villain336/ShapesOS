// ShapesOS — Phase 11 (bizsync): what Settings → Connectors → Business sync
// shows per provider — the connection, mapped-object counts, the recent run
// log (status, last run, errors) and, for QuickBooks / Xero, the export
// ledger counts and the Xero organisations. Reads only.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { BIZ_PROVIDERS, recentRuns, type BizProvider, type RunView } from "./links";
import { exportStatus, type ExportStatus } from "./accounting/export";
import { tenantsOf } from "./xero/tenants";
import type { XeroTenant } from "./xero/api";

export interface ProviderStatus {
  provider: BizProvider;
  connection: { id: string; status: string; label: string | null; connectedAt: Date } | null;
  links: Record<string, number>;
  runs: RunView[];
  lastRun: RunView | null;
  lastError: { at: Date; operation: string; error: string } | null;
  exports: ExportStatus | null;
  tenants: XeroTenant[] | null;
  tenantId: string | null;
  tenantError: string | null;
}

export async function bizSyncStatus(workspaceId: string): Promise<ProviderStatus[]> {
  const conns = await prisma.connectorConnection.findMany({
    where: { workspaceId, connectorKey: { in: [...BIZ_PROVIDERS] } },
    orderBy: { connectedAt: "desc" },
  });
  const counts = await withWorkspaceScope(workspaceId, (tx) =>
    tx.bizSyncLink.groupBy({ by: ["provider", "objectType"], where: { workspaceId }, _count: { _all: true } }),
  );
  const out: ProviderStatus[] = [];
  for (const provider of BIZ_PROVIDERS) {
    const conn = conns.find((c) => c.connectorKey === provider && c.status === "active") ?? conns.find((c) => c.connectorKey === provider) ?? null;
    const meta = (conn?.meta ?? {}) as Record<string, unknown>;
    const runs = await recentRuns(workspaceId, provider, 10);
    const failed = runs.find((r) => r.status === "failed" && r.error);
    out.push({
      provider,
      connection: conn ? { id: conn.id, status: conn.status, label: typeof meta.label === "string" ? meta.label : null, connectedAt: conn.connectedAt } : null,
      links: Object.fromEntries(counts.filter((c) => c.provider === provider).map((c) => [c.objectType, c._count._all])),
      runs,
      lastRun: runs[0] ?? null,
      lastError: failed ? { at: failed.startedAt, operation: failed.operation, error: failed.error! } : null,
      exports: provider === "quickbooks" || provider === "xero" ? await exportStatus(workspaceId, provider) : null,
      tenants: provider === "xero" && conn ? tenantsOf(meta) : null,
      tenantId: provider === "xero" && typeof meta.tenantId === "string" ? meta.tenantId : null,
      tenantError: provider === "xero" && typeof meta.xeroTenantError === "string" ? meta.xeroTenantError : null,
    });
  }
  return out;
}
