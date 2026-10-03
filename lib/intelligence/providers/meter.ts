// Marketr — Phase 10 M6: data-cost metering + circuit breakers.
// api_meter is APPEND-ONLY (no UPDATE/DELETE service methods) — the same
// doctrine as mission_events / command_audit. Every external data call lands
// here; this table is the margin dashboard's source of truth.

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import type { SerpVendorId } from "./types";

export type ApiMeterKind = "serp_call" | "volume_lookup" | "ai_prompt" | "backlink_pull";

export interface MeterRecord {
  vendor: string;
  meter: ApiMeterKind;
  quantity: number;
  costUsd: number;
}

/** Append one metered event. costUsd may be 0 (e.g. cache hits are free). */
export async function recordApiMeter(
  workspaceId: string,
  vendor: string,
  meter: ApiMeterKind,
  quantity: number,
  costUsd: number,
): Promise<void> {
  const period = currentPeriod();
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.apiMeterEntry.create({
      data: { workspaceId, vendor, meter, quantity, costUsd, period },
    }),
  );
}

export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Pure budget math — tested without a DB. Amounts in cents. */
export function budgetAllows(spendCents: number, capCents: number | null, estimatedCents: number): boolean {
  if (capCents == null) return true; // no cap configured
  return spendCents + estimatedCents <= capCents;
}

export interface BudgetStatus {
  spendCents: number;
  capCents: number | null;
  remainingCents: number | null;
}

/** Sum of this period's api_meter spend + the workspace's total cap. */
export async function getBudgetStatus(workspaceId: string, period = currentPeriod()): Promise<BudgetStatus> {
  const [spend, configs] = await Promise.all([
    withWorkspaceScope(workspaceId, (tx) =>
      tx.apiMeterEntry.aggregate({
        where: { workspaceId, period },
        _sum: { costUsd: true },
      }),
    ),
    withWorkspaceScope(workspaceId, (tx) => tx.serpVendorConfig.findMany({ where: { workspaceId } })),
  ]);
  const spendCents = Math.round(Number(spend._sum.costUsd ?? 0) * 100);
  const caps = configs.map((c) => c.monthlyBudgetCapCents).filter((c): c is number => c != null);
  const capCents = caps.length > 0 ? caps.reduce((a, b) => a + b, 0) : null;
  return {
    spendCents,
    capCents,
    remainingCents: capCents == null ? null : capCents - spendCents,
  };
}

import { BudgetCapExceeded } from "./types";

/**
 * Circuit breaker: throws BudgetCapExceeded before any external call that
 * would push this period's spend over the configured cap.
 */
export async function assertBudgetAvailable(workspaceId: string, estimatedCostUsd: number): Promise<void> {
  const status = await getBudgetStatus(workspaceId);
  const estimatedCents = Math.round(estimatedCostUsd * 100);
  if (!budgetAllows(status.spendCents, status.capCents, estimatedCents)) {
    throw new BudgetCapExceeded(workspaceId, status.spendCents, status.capCents ?? 0);
  }
}

export interface CostSummaryRow {
  vendor: string;
  meter: ApiMeterKind;
  calls: number;
  quantity: number;
  costUsd: number;
}

export interface DataCostSummary {
  period: string;
  rows: CostSummaryRow[];
  totalCostUsd: number;
  totalCalls: number;
  capCents: number | null;
  spendCents: number;
  /** Share of volume_lookup calls served from cache (0..1), null when none. */
  volumeCacheHitRate: number | null;
}

/** Pure aggregation over meter rows — the dashboard shape, tested without a DB. */
export function summarizeMeter(
  entries: Array<{ vendor: string; meter: ApiMeterKind; quantity: number; costUsd: number }>,
  period: string,
): Pick<DataCostSummary, "rows" | "totalCostUsd" | "totalCalls" | "volumeCacheHitRate"> {
  const byKey = new Map<string, CostSummaryRow>();
  let totalCostUsd = 0;
  let totalCalls = 0;
  let volumeLookups = 0;
  let volumeHits = 0;
  for (const e of entries) {
    const key = `${e.vendor}::${e.meter}`;
    const row = byKey.get(key) ?? { vendor: e.vendor, meter: e.meter, calls: 0, quantity: 0, costUsd: 0 };
    row.calls += 1;
    row.quantity += e.quantity;
    row.costUsd += Number(e.costUsd);
    byKey.set(key, row);
    totalCostUsd += Number(e.costUsd);
    totalCalls += 1;
    if (e.meter === "volume_lookup") {
      volumeLookups += 1;
      if (e.vendor === "volume_cache") volumeHits += 1;
    }
  }
  const rows = [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd);
  return {
    rows,
    totalCostUsd,
    totalCalls,
    volumeCacheHitRate: volumeLookups > 0 ? volumeHits / volumeLookups : null,
  };
}

export async function getDataCostSummary(
  workspaceId: string,
  period = currentPeriod(),
): Promise<DataCostSummary> {
  const entries = await withWorkspaceScope(workspaceId, (tx) =>
    tx.apiMeterEntry.findMany({
      where: { workspaceId, period },
      select: { vendor: true, meter: true, quantity: true, costUsd: true },
    }),
  );
  const status = await getBudgetStatus(workspaceId, period);
  return {
    period,
    ...summarizeMeter(
      entries.map((e) => ({
        vendor: e.vendor,
        meter: e.meter as ApiMeterKind,
        quantity: e.quantity,
        costUsd: Number(e.costUsd),
      })),
      period,
    ),
    capCents: status.capCents,
    spendCents: status.spendCents,
  };
}

/** Update the default vendor for a workspace (admin-gated at the API layer). */
export async function setDefaultVendor(workspaceId: string, vendor: SerpVendorId): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.serpVendorConfig.findUnique({
      where: { workspaceId_vendor: { workspaceId, vendor } },
      select: { routingRules: true },
    });
    const rules = { ...((existing?.routingRules ?? {}) as Record<string, unknown>), default: vendor };
    await tx.serpVendorConfig.upsert({
      where: { workspaceId_vendor: { workspaceId, vendor } },
      update: { routingRules: rules },
      create: { workspaceId, vendor, routingRules: rules, status: "active" },
    });
  });
}
