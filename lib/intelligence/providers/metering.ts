// Marketr — Phase 10: shared cost-metering primitive.
//
// The `recordApiMeter` contract every Phase 10 module codes to:
//   import { recordApiMeter } from "@/lib/intelligence/providers";
//   await recordApiMeter(workspaceId, vendor, meter, quantity, costUsd);
//
// Writes append-only rows to `api_meter` (the M7 cost-tracking source and the
// billing input). Metering never breaks the data path it measures: on write
// failure it degrades silently and the cost dashboard shows a gap, never a
// fabricated zero.

import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import type { ApiMeterKind } from "@prisma/client";

/** Current billing bucket label, e.g. "2026-09". */
export function currentMeterPeriod(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/**
 * Append a cost-meter row. Append-only by doctrine (no UPDATE/DELETE service
 * methods) — the same as mission_events / command_audit.
 */
export async function recordApiMeter(
  workspaceId: string,
  vendor: string,
  meter: ApiMeterKind | string,
  quantity: number,
  costUsd: number,
): Promise<void> {
  const period = currentMeterPeriod();
  await withWorkspaceScope(workspaceId, async (tx: TxClient) => {
    await tx.apiMeterEntry.create({
      data: {
        workspaceId,
        vendor,
        meter: meter as ApiMeterKind,
        quantity: Math.max(0, Math.floor(quantity)),
        costUsd: Math.max(0, costUsd),
        period,
      },
    });
  }).catch(() => {
    // Metering must never break the data path it measures.
  });
}

/**
 * Month-to-date metered spend for a workspace (+ optional vendor/meter
 * filter). Honest-cost reporting for the M7 verification battery.
 */
export async function meteredSpendMtd(
  workspaceId: string,
  vendor?: string,
  meter?: ApiMeterKind | string,
): Promise<{ period: string; quantity: number; costUsd: number; rows: number }> {
  const period = currentMeterPeriod();
  const rows = await withWorkspaceScope(workspaceId, (tx: TxClient) =>
    tx.apiMeterEntry.findMany({
      where: {
        workspaceId,
        period,
        ...(vendor ? { vendor } : {}),
        ...(meter ? { meter: meter as ApiMeterKind } : {}),
      },
      select: { quantity: true, costUsd: true },
    }),
  );
  let quantity = 0;
  let costUsd = 0;
  for (const r of rows) {
    quantity += r.quantity;
    costUsd += Number(r.costUsd);
  }
  return { period, quantity, costUsd, rows: rows.length };
}
