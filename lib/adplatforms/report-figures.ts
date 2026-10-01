// Marketr — Phase 18 slice 6: ads section for the Phase 16 branded report
// engine's client performance reports.
//
// The engine's data hook is ReportFigure[] — every figure MUST carry a
// source pointer or the render service refuses to produce a PDF (Tico's
// iron guardrail: never invent numbers). buildAdReportFigures() turns
// AdReport rows into grounded figures: total spend, attributed revenue,
// blended ROAS, spend by platform, top campaigns, and an approval-lineage
// note. With no rows it returns a single grounded "no ad data" note so the
// section renders honestly instead of vanishing.

import type { ReportFigure } from "@/lib/reports/figures";
import {
  rollupByCampaign,
  rollupByPlatform,
  rollupRows,
  type AdReportRowLike,
} from "./unified-reporting";

export interface AdReportSectionInput {
  workspaceId: string;
  /** Inclusive start (date portion). */
  from: Date;
  /** Inclusive end (date portion). */
  to: Date;
  /** Human period label for the report, e.g. "September 2026". */
  periodLabel: string;
  rows: AdReportRowLike[];
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function roasText(roas: number | null): string {
  if (roas === null) return "—";
  return `${roas.toFixed(2)}×`;
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the grounded ads figures for a client performance report.
 * Never fabricates: every value comes from the input rows, every figure
 * carries a source pointer back to the AdReport rows behind it.
 */
export function buildAdReportFigures(input: AdReportSectionInput): ReportFigure[] {
  const refBase = `adreport:${input.workspaceId}:${day(input.from)}..${day(input.to)}`;
  const source = (suffix: string) => ({
    provider: "adreport",
    ref: `${refBase}:${suffix}`,
    capturedAt: new Date().toISOString(),
  });

  if (input.rows.length === 0) {
    return [
      {
        key: "ads_no_data",
        label: "Ad spend",
        value: "No ad spend in period",
        source: source("empty"),
        delta: input.periodLabel,
      },
    ];
  }

  const totals = rollupRows(input.rows);
  const byPlatform = rollupByPlatform(input.rows);
  const byCampaign = rollupByCampaign(input.rows).slice(0, 5);

  const approvalIds = new Set(
    input.rows.map((r) => r.approvalId).filter((id): id is string => !!id),
  );
  const receiptCount = new Set(
    input.rows.map((r) => r.platformReceiptId).filter((id): id is string => !!id),
  ).size;

  const figures: ReportFigure[] = [
    {
      key: "ads_total_spend",
      label: "Ad spend",
      value: money(totals.spendCents),
      source: source("spend"),
      delta: `${input.rows.length} daily rows · ${input.periodLabel}`,
    },
    {
      key: "ads_total_revenue",
      label: "Attributed ad revenue",
      value: money(totals.revenueCents),
      source: source("revenue"),
      delta: `${totals.conversions} conversions`,
    },
    {
      key: "ads_blended_roas",
      label: "Blended ROAS",
      value: totals.roas === null ? "— (no spend in period)" : roasText(totals.roas),
      source: source("roas"),
      delta: "revenue ÷ spend",
    },
    {
      key: "ads_spend_by_platform",
      label: "Spend by platform",
      value: byPlatform
        .map((p) => `${p.platformLabel} ${money(p.totals.spendCents)}`)
        .join(" · "),
      source: source("by-platform"),
    },
    {
      key: "ads_top_campaigns",
      label: "Top campaigns",
      value: byCampaign
        .map((c) => `${c.campaignName} (${money(c.totals.spendCents)}, ${roasText(c.totals.roas)})`)
        .join(" · "),
      source: source("by-campaign"),
    },
    {
      key: "ads_approval_lineage",
      label: "Spend governance",
      value: `${approvalIds.size} approval${approvalIds.size === 1 ? "" : "s"} · ${receiptCount} platform receipt${receiptCount === 1 ? "" : "s"}`,
      source: source("lineage"),
      delta: "every dollar executed under a SpendApproval; rows trace to campaign → approval → platform receipt",
    },
  ];
  return figures;
}
