// Marketr — Phase 18 slice 6: unified cross-platform reporting.
//
// One analytics home for ad spend: AdReport rows (fed by the Amazon,
// StackAdapt connectors and the guided walmart/spotify imports) roll up into
// per-platform and per-campaign views. Aggregation is pure (testable without
// a DB); fetchAdReportRows() is the only prisma touchpoint.

import { prisma } from "@/lib/prisma";
import type { AdsPlatformKey } from "./types";
import { ADS_PLATFORMS } from "./types";

/** Minimal row shape the rollups need — AdReport rows projected with joins. */
export interface AdReportRowLike {
  platformKey: string;
  platformLabel: string;
  campaignId: string;
  campaignName: string;
  date: Date;
  spendCents: number;
  impressions: number;
  clicks: number;
  /** Stored CTR fraction (0.021 = 2.1%) — may be null; derived when absent. */
  ctr: number | null;
  conversions: number;
  revenueCents: number;
  approvalId: string | null;
  platformReceiptId: string | null;
}

export interface MetricTotals {
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueCents: number;
  /** Derived CTR (clicks/impressions), null when no impressions. */
  ctr: number | null;
  /** revenueCents / spendCents — NULL when spend is zero (never divide by 0). */
  roas: number | null;
  rowCount: number;
}

export function emptyTotals(): MetricTotals {
  return { spendCents: 0, impressions: 0, clicks: 0, conversions: 0, revenueCents: 0, ctr: null, roas: null, rowCount: 0 };
}

function accumulate(t: MetricTotals, r: AdReportRowLike): void {
  t.spendCents += r.spendCents;
  t.impressions += r.impressions;
  t.clicks += r.clicks;
  t.conversions += r.conversions;
  t.revenueCents += r.revenueCents;
  t.rowCount += 1;
}

function finalize(t: MetricTotals): MetricTotals {
  t.ctr = t.impressions > 0 ? t.clicks / t.impressions : null;
  // Zero-spend guard: ROAS is undefined when nothing was spent — null, never NaN/Infinity.
  t.roas = t.spendCents > 0 ? t.revenueCents / t.spendCents : null;
  return t;
}

/** Roll every row into one totals object. */
export function rollupRows(rows: AdReportRowLike[]): MetricTotals {
  const t = emptyTotals();
  for (const r of rows) accumulate(t, r);
  return finalize(t);
}

export interface PlatformRollup {
  platformKey: string;
  platformLabel: string;
  totals: MetricTotals;
}

/** Per-platform rollup, ordered by spend desc. */
export function rollupByPlatform(rows: AdReportRowLike[]): PlatformRollup[] {
  const byKey = new Map<string, PlatformRollup>();
  for (const r of rows) {
    let entry = byKey.get(r.platformKey);
    if (!entry) {
      entry = { platformKey: r.platformKey, platformLabel: r.platformLabel, totals: emptyTotals() };
      byKey.set(r.platformKey, entry);
    }
    accumulate(entry.totals, r);
  }
  const out = [...byKey.values()];
  for (const e of out) finalize(e.totals);
  out.sort((a, b) => b.totals.spendCents - a.totals.spendCents);
  return out;
}

export interface CampaignRollup {
  campaignId: string;
  campaignName: string;
  platformKey: string;
  platformLabel: string;
  totals: MetricTotals;
}

/** Per-campaign rollup, ordered by spend desc. */
export function rollupByCampaign(rows: AdReportRowLike[]): CampaignRollup[] {
  const byId = new Map<string, CampaignRollup>();
  for (const r of rows) {
    let entry = byId.get(r.campaignId);
    if (!entry) {
      entry = {
        campaignId: r.campaignId,
        campaignName: r.campaignName,
        platformKey: r.platformKey,
        platformLabel: r.platformLabel,
        totals: emptyTotals(),
      };
      byId.set(r.campaignId, entry);
    }
    accumulate(entry.totals, r);
  }
  const out = [...byId.values()];
  for (const e of out) finalize(e.totals);
  out.sort((a, b) => b.totals.spendCents - a.totals.spendCents);
  return out;
}

export interface ReportRange {
  /** Inclusive start (date portion). */
  from: Date;
  /** Inclusive end (date portion). */
  to: Date;
}

/** Default reporting window: last 30 days, inclusive. */
export function defaultRange(now = new Date()): ReportRange {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from, to };
}

/** Parse YYYY-MM-DD; null when the string is not a valid calendar date. */
export function parseRangeDate(value: string | undefined | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface FetchAdReportOptions {
  from?: Date;
  to?: Date;
  /** Restrict to these platform keys; undefined = all. */
  platformKeys?: string[];
  limit?: number;
}

/**
 * Pull AdReport rows for a workspace, projected into AdReportRowLike.
 * Date bounds are inclusive on the date portion.
 */
export async function fetchAdReportRows(
  workspaceId: string,
  options: FetchAdReportOptions = {},
): Promise<AdReportRowLike[]> {
  const rows = await prisma.adReport.findMany({
    where: {
      workspaceId,
      ...(options.from || options.to
        ? { date: { gte: options.from, lte: options.to } }
        : {}),
      ...(options.platformKeys && options.platformKeys.length
        ? { campaign: { platformKey: { in: options.platformKeys as AdsPlatformKey[] } } }
        : {}),
    },
    orderBy: [{ date: "asc" }],
    take: options.limit ?? 5000,
    include: {
      campaign: { select: { id: true, name: true, platformKey: true } },
    },
  });
  return rows.map((r) => {
    const key = r.campaign.platformKey as string;
    const def = (ADS_PLATFORMS as Record<string, { displayName?: string }>)[key];
    return {
      platformKey: key,
      platformLabel: def?.displayName ?? key,
      campaignId: r.campaign.id,
      campaignName: r.campaign.name,
      date: r.date,
      spendCents: r.spendCents,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      conversions: r.conversions,
      revenueCents: r.revenueCents,
      approvalId: r.approvalId,
      platformReceiptId: r.platformReceiptId,
    };
  });
}
