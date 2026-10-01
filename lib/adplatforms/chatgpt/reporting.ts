// Marketr — Wave 2 ChatGPT Ads slice 4: reporting.
//
// pull_report runs through the StackAdapt delivery report (the buying rail)
// and ingests AdReport rows — the same unified rows every other platform
// uses, so ChatGPT spend shows up in the Phase 18 unified reports.
// Aggregation (spend, CTR, CPA) is pure and tested; a >20% CPA drift between
// the last 7 days and the prior 7 raises an alert event (the OS's review
// task) via the chatgpt_cpa_drift trigger.

import { prisma } from "@/lib/prisma";
import { pullStackAdaptReport, type PullStackAdaptReportDeps } from "../stackadapt/reporting";
import { emitAlert } from "@/lib/alerts/evaluate";
import { ChatGPTAdsError } from "./types";

export const CPA_DRIFT_THRESHOLD = 0.2;
export const VARIANCE_WINDOW_DAYS = 7;

export interface AdReportRowLike {
  date: Date;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueCents: number;
}

export interface DaySummary {
  date: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  conversions: number;
  cpaCents: number | null;
}

export interface ReportSummary {
  days: DaySummary[];
  totals: {
    spendCents: number;
    impressions: number;
    clicks: number;
    ctr: number | null;
    conversions: number;
    revenueCents: number;
    cpaCents: number | null;
  };
}

/** Pure aggregation over daily AdReport-style rows. */
export function summarizeAdRows(rows: AdReportRowLike[]): ReportSummary {
  const byDay = new Map<string, AdReportRowLike[]>();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    const list = byDay.get(key) ?? [];
    list.push(r);
    byDay.set(key, list);
  }
  const days: DaySummary[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, rs]) => {
      const spendCents = rs.reduce((s, r) => s + r.spendCents, 0);
      const impressions = rs.reduce((s, r) => s + r.impressions, 0);
      const clicks = rs.reduce((s, r) => s + r.clicks, 0);
      const conversions = rs.reduce((s, r) => s + r.conversions, 0);
      return {
        date,
        spendCents,
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions : null,
        conversions,
        cpaCents: conversions > 0 ? spendCents / conversions : null,
      };
    });
  const spendCents = days.reduce((s, d) => s + d.spendCents, 0);
  const impressions = days.reduce((s, d) => s + d.impressions, 0);
  const clicks = days.reduce((s, d) => s + d.clicks, 0);
  const conversions = days.reduce((s, d) => s + d.conversions, 0);
  const revenueCents = rows.reduce((s, r) => s + r.revenueCents, 0);
  return {
    days,
    totals: {
      spendCents,
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : null,
      conversions,
      revenueCents,
      cpaCents: conversions > 0 ? spendCents / conversions : null,
    },
  };
}

function cpaOf(rows: AdReportRowLike[]): number | null {
  const spend = rows.reduce((s, r) => s + r.spendCents, 0);
  const conv = rows.reduce((s, r) => s + r.conversions, 0);
  return conv > 0 ? spend / conv : null;
}

export interface CpaDrift {
  recentCpaCents: number | null;
  priorCpaCents: number | null;
  driftRatio: number | null;
  flaggable: boolean;
  reason: string | null;
}

/** Pure CPA-drift computation: last 7 days vs the prior 7. No side effects. */
export function computeCpaDrift(rows: AdReportRowLike[], now: Date = new Date()): CpaDrift {
  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  const recentStart = new Date(cutoff);
  recentStart.setUTCDate(recentStart.getUTCDate() - VARIANCE_WINDOW_DAYS);
  const priorStart = new Date(cutoff);
  priorStart.setUTCDate(priorStart.getUTCDate() - 2 * VARIANCE_WINDOW_DAYS);

  const recent = rows.filter((r) => r.date >= recentStart && r.date < cutoff);
  const prior = rows.filter((r) => r.date >= priorStart && r.date < recentStart);
  const recentCpaCents = cpaOf(recent);
  const priorCpaCents = cpaOf(prior);

  if (recentCpaCents == null || priorCpaCents == null || priorCpaCents === 0) {
    return {
      recentCpaCents,
      priorCpaCents,
      driftRatio: null,
      flaggable: false,
      reason: "insufficient conversion data to compute CPA drift",
    };
  }
  const driftRatio = (recentCpaCents - priorCpaCents) / priorCpaCents;
  return {
    recentCpaCents,
    priorCpaCents,
    driftRatio,
    flaggable: Math.abs(driftRatio) > CPA_DRIFT_THRESHOLD,
    reason: null,
  };
}

export interface CpaVarianceResult extends CpaDrift {
  flagged: boolean;
  alertEventIds: string[];
}
export async function checkCpaVariance(
  ctx: { workspaceId: string; actor: string },
  input: {
    chatGPTCampaignId: string;
    campaignName: string;
    paidCampaignId: string;
    rows: AdReportRowLike[];
    now?: Date;
    raiseAlert?: (a: {
      workspaceId: string;
      title: string;
      body: string;
      link: string;
      dedupKey: string;
    }) => Promise<string[]>;
  },
): Promise<CpaVarianceResult> {
  const drift = computeCpaDrift(input.rows, input.now);
  if (!drift.flaggable) {
    return { ...drift, flagged: false, alertEventIds: [] };
  }
  const { recentCpaCents: recentCpa, priorCpaCents: priorCpa, driftRatio } = drift;
  // flaggable implies all three are non-null; guards for the type checker.
  if (recentCpa == null || priorCpa == null || driftRatio == null) {
    return { ...drift, flagged: false, alertEventIds: [] };
  }

  const direction = driftRatio > 0 ? "rose" : "fell";
  const cutoff = new Date(input.now ?? new Date());
  cutoff.setUTCHours(0, 0, 0, 0);
  const dedupKey = `chatgpt_cpa_drift:${input.chatGPTCampaignId}:${cutoff.toISOString().slice(0, 10)}`;
  const raise = input.raiseAlert ?? (async (a) => {
    await ensureCpaDriftRule(ctx.workspaceId);
    const outcomes = await emitAlert({
      trigger: "chatgpt_cpa_drift",
      workspaceId: a.workspaceId,
      title: a.title,
      body: a.body,
      link: a.link,
      dedupKey: a.dedupKey,
    });
    return outcomes.map((o) => o.eventId).filter((id): id is string => !!id);
  });
  const alertEventIds = await raise({
    workspaceId: ctx.workspaceId,
    title: `ChatGPT ads: CPA ${direction} ${Math.abs(driftRatio * 100).toFixed(0)}% — ${input.campaignName}`,
    body: `7-day CPA ${direction} from $${(priorCpa / 100).toFixed(2)} to $${(recentCpa / 100).toFixed(2)} — past the 20% variance threshold. Review targeting, tiers, and creative before the next flight.`,
    link: "/dashboard/media/advertising/chatgpt",
    dedupKey,
  });
  return { ...drift, flagged: true, recentCpaCents: recentCpa, priorCpaCents: priorCpa, driftRatio, reason: null, alertEventIds };
}

async function ensureCpaDriftRule(workspaceId: string): Promise<void> {
  const existing = await prisma.alertRule.findFirst({
    where: { workspaceId, trigger: "chatgpt_cpa_drift", enabled: true },
  });
  if (existing) return;
  await prisma.alertRule.create({
    data: {
      workspaceId,
      name: "ChatGPT ads CPA drift",
      trigger: "chatgpt_cpa_drift",
      conditions: { thresholdRatio: CPA_DRIFT_THRESHOLD },
      cooldownSec: 24 * 3600,
      digest: "immediate",
      enabled: true,
    },
  });
}

export interface PullChatGPTReportInput {
  chatGPTCampaignId: string;
  startDate: string;
  endDate: string;
  stackAdapt?: Pick<PullStackAdaptReportDeps, "fetchImpl" | "resolveKey">;
}

export interface PullChatGPTReportResult {
  chatGPTCampaignId: string;
  upserted: number;
  skippedNoCampaign: number;
  summary: ReportSummary;
  variance: CpaVarianceResult;
}

/**
 * pull_report for a ChatGPT campaign: StackAdapt delivery → AdReport rows →
 * summary → CPA variance check. Reads only from the platform; the alert is
 * the only side effect besides the ingested rows.
 */
export async function pullChatGPTReport(
  ctx: { workspaceId: string; actor: string },
  input: PullChatGPTReportInput,
): Promise<PullChatGPTReportResult> {
  const campaign = await prisma.chatGPTCampaign.findFirst({
    where: { id: input.chatGPTCampaignId, workspaceId: ctx.workspaceId },
    include: { campaign: { select: { id: true, name: true, accountId: true } } },
  });
  if (!campaign) {
    throw new ChatGPTAdsError("NOT_FOUND", `ChatGPT campaign ${input.chatGPTCampaignId} not found.`);
  }
  if (!campaign.stackAdaptExternalId) {
    throw new ChatGPTAdsError(
      "NOT_LAUNCHED",
      "Report pull refused: the campaign was never launched (no StackAdapt external id).",
    );
  }

  const pulled = await pullStackAdaptReport({
    workspaceId: ctx.workspaceId,
    accountId: campaign.campaign.accountId,
    startDate: input.startDate,
    endDate: input.endDate,
    campaignIds: [campaign.stackAdaptExternalId],
    fetchImpl: input.stackAdapt?.fetchImpl,
    resolveKey: input.stackAdapt?.resolveKey,
  });

  // Re-read the last 14 days for summary + variance (ingest is idempotent).
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - 2 * VARIANCE_WINDOW_DAYS);
  const rows = await prisma.adReport.findMany({
    where: { campaignId: campaign.campaign.id, date: { gte: since } },
    orderBy: { date: "asc" },
  });

  const summary = summarizeAdRows(rows);
  const variance = await checkCpaVariance(ctx, {
    chatGPTCampaignId: campaign.id,
    campaignName: campaign.campaign.name,
    paidCampaignId: campaign.campaign.id,
    rows,
  });

  return {
    chatGPTCampaignId: campaign.id,
    upserted: pulled.ingested.upserted,
    skippedNoCampaign: pulled.ingested.skippedNoCampaign,
    summary,
    variance,
  };
}

/** Fetch rows for the report views (server components). */
export async function getChatGPTReportRows(
  workspaceId: string,
  paidCampaignId: string,
  days: number,
): Promise<AdReportRowLike[]> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - days);
  const campaign = await prisma.paidAdCampaign.findFirst({
    where: { id: paidCampaignId, workspaceId },
    select: { id: true },
  });
  if (!campaign) throw new ChatGPTAdsError("NOT_FOUND", "Campaign not found.");
  return prisma.adReport.findMany({
    where: { campaignId: campaign.id, date: { gte: since } },
    orderBy: { date: "asc" },
  });
}
