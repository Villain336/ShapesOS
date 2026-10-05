// Marketr — Phase 6 I1 audit 7: Paid media — NEW paid-efficiency pack.
// Phase 5 buying data: pools, spend, attribution, lift dashboards.
//
// Spend vs. attribution from real Phase 5 records. When no buying activity
// exists, the audit says so (partial) instead of inventing efficiency numbers.

import { prisma } from "@/lib/prisma";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { listSpend } from "@/lib/attribution/spend";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runPaidAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];

  let poolSpendCents = 0, poolCapCents = 0, buyCount = 0, activeBuys = 0;
  let attrSpendCents = 0, touchCount = 0;
  let mediaReady = false;

  try {
    mediaReady = await safetyTablesReady().catch(() => false);
    if (mediaReady) {
      const stores = mediaStores();
      const [pools, buys] = await Promise.all([
        stores.pools.list(ctx.workspaceId).catch(() => []),
        stores.buys.list(ctx.workspaceId, 50).catch(() => []),
      ]);
      for (const p of pools) {
        poolCapCents += Number(p.capCents ?? 0);
        poolSpendCents += Number(p.capCents ?? 0) - Number(p.remainingCents ?? 0);
      }
      buyCount = buys.length;
      activeBuys = buys.filter((b) => ["approved", "executing", "live"].includes(String(b.status))).length;
    }
  } catch {
    mediaReady = false;
  }

  try {
    const rows = await listSpend(ctx.workspaceId, { limit: 200 } as never).catch(() => []) as Array<{ amountCents?: number }>;
    attrSpendCents = rows.reduce((s, r) => s + Number(r.amountCents ?? 0), 0);
    touchCount = await prisma.attributionTouch.count({ where: { workspaceId: ctx.workspaceId } }).catch(() => 0);
  } catch {
    // attribution tables may not exist in this workspace — degrade, don't fail
  }

  const hasAny = mediaReady && (buyCount > 0 || poolCapCents > 0) || attrSpendCents > 0 || touchCount > 0;

  if (!hasAny) {
    findings.push({
      severity: "info", title: "No paid-media activity on record",
      detail: "No budget pools, buys, or attributed spend found. This audit activates the moment the first pool is funded.",
      dataSource: "MediaBuy + BudgetPool + AttributionSpend",
    });
    return {
      id: "paid", name: "Paid media", score: null, completeness: "unavailable",
      findings, dataSource: "Phase 5 buying data (pools, buys, attribution)",
      computedAt: nowIso(),
    };
  }

  const meta = ctx.connectors.meta, gads = ctx.connectors["google-ads"];
  for (const c of [meta, gads]) {
    if (c.status === "disconnected") {
      findings.push({
        severity: "warn", title: `${c.label} not connected`,
        detail: `Connect ${c.label} so the audit sees platform-side delivery, not just ShapesOS-side spend records.`,
        dataSource: "ConnectorConnection",
      });
    }
  }

  if (poolCapCents > 0) {
    const util = poolSpendCents / poolCapCents;
    findings.push({
      severity: util > 0.95 ? "warn" : "info",
      title: `Pool utilization ${(util * 100).toFixed(1)}% of ${(poolCapCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} committed`,
      detail: util > 0.95
        ? "Pools are nearly exhausted — top up or reallocate before buys hit their caps."
        : "Spend is pacing inside committed pools.",
      dataSource: "BudgetPool (Phase 5)",
    });
  }
  if (buyCount > 0) {
    findings.push({
      severity: "info",
      title: `${buyCount} buys on record (${activeBuys} active)`,
      detail: activeBuys > 0
        ? "Active buys exist — efficiency improves when each buy carries attribution touches."
        : "No active buys right now.",
      dataSource: "MediaBuy (Phase 5)",
    });
  }
  if (attrSpendCents > 0 || touchCount > 0) {
    const efficiency = touchCount > 0 ? attrSpendCents / 100 / touchCount : null;
    findings.push({
      severity: touchCount === 0 ? "warn" : "info",
      title: `Attribution: ${(attrSpendCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} spend across ${touchCount} touches`,
      detail: efficiency != null
        ? `Blended ${(efficiency).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })} per attributed touch — drill into the lift dashboards per buy for the real read.`
        : "Spend is logged but no attribution touches exist — wire conversion tracking so spend can be judged.",
      dataSource: "AttributionSpend + AttributionTouch",
    });
  }

  const connectorPenalty = [meta, gads].some((c) => c.status === "disconnected") ? 10 : 0;
  return {
    id: "paid", name: "Paid media",
    score: clampScore(60 - connectorPenalty + (touchCount > 0 ? 15 : 0)),
    completeness: [meta, gads].every((c) => c.status !== "disconnected") ? "full" : "partial",
    findings, dataSource: "Phase 5 buying data (pools, buys, attribution)",
    computedAt: nowIso(),
  };
}
