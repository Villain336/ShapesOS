// ShapesOS — Phase 15.4 (zernio): Zernio ad insights into the existing
// Advertising reports (lib/adplatforms: ad_platforms → ad_accounts →
// paid_ad_campaigns → ad_reports, rolled up by unified-reporting.ts), so the
// Reports page shows Meta / Google / TikTok / LinkedIn / Pinterest / X /
// OpenAI spend next to Amazon and StackAdapt. No second reporting store.
//
// Source: getAdTree (GET /v1/ads/tree?profileId=<ours>&timeIncrement=1) —
// every campaign on the workspace's profile with a daily[] series
// (AdDailyMetrics). Money is in each campaign's own currency (Zernio does not
// normalise to USD); it is stored in minor units of that currency and the
// currency is kept on the row's raw payload. ctr is recomputed as a fraction
// (Zernio's is a percentage). Reads only — never gated.

import type { PaidAdStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureAdPlatforms } from "@/lib/adplatforms/oauth";
import { ingestAdReportRows, type NormalizedAdRow } from "@/lib/adplatforms/reporting";
import type { ZernioCampaignDoc } from "./spec";
import type { ZernioScope } from "./tenancy";

/** ISO 4217 currencies with no minor unit (amounts are sent as-is). */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "VND", "ISK", "HUF", "TWD", "UGX", "PYG", "XOF", "XAF"]);

export function toMinorUnits(amount: unknown, currency: string | null | undefined): number {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(ZERO_DECIMAL.has((currency ?? "").toUpperCase()) ? n : n * 100);
}

function campaignStatus(s: string | undefined): PaidAdStatus {
  switch (s) {
    case "active":
    case "pending_review":
      return "live";
    case "paused":
      return "paused";
    case "completed":
    case "cancelled":
      return "ended";
    default:
      return "draft";
  }
}

/** Map one tree campaign's daily[] into normalized rows (PURE). */
export function normalizeZernioCampaign(c: ZernioCampaignDoc): NormalizedAdRow[] {
  const currency = c.currency ?? null;
  return (c.daily ?? [])
    .filter((d) => typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .map((d) => {
      const impressions = Math.max(0, Math.round(Number(d.impressions ?? 0) || 0));
      const clicks = Math.max(0, Math.round(Number(d.clicks ?? 0) || 0));
      return {
        externalCampaignId: c.platformCampaignId,
        date: new Date(`${d.date}T00:00:00Z`),
        spendCents: toMinorUnits(d.spend, currency),
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions : null,
        conversions: Number(d.conversions ?? 0) || 0,
        revenueCents: toMinorUnits(d.purchaseValue, currency),
        approvalId: null,
        platformReceiptId: `zernio:${c.platform}:${c.platformCampaignId}`,
        raw: { source: "zernio getAdTree", platform: c.platform, currency, day: d },
      } satisfies NormalizedAdRow;
    });
}

export interface ZernioReportSyncResult {
  campaigns: number;
  upserted: number;
  skippedNoCampaign: number;
}

/** Pull the profile's campaign tree for [fromDate, toDate] and upsert ad_reports rows. */
export async function syncZernioAdReports(
  scope: ZernioScope,
  range: { fromDate: string; toDate: string },
): Promise<ZernioReportSyncResult> {
  await ensureAdPlatforms(scope.workspaceId);
  const platform = await prisma.adPlatform.findUniqueOrThrow({
    where: { workspaceId_key: { workspaceId: scope.workspaceId, key: "zernio" } },
    select: { id: true },
  });
  const result: ZernioReportSyncResult = { campaigns: 0, upserted: 0, skippedNoCampaign: 0 };
  for (let page = 1; page <= 10; page++) {
    const tree = await scope.client.getAdTree({
      profileId: scope.profileId, fromDate: range.fromDate, toDate: range.toDate, timeIncrement: 1, limit: 100, page,
    });
    for (const c of tree.campaigns) {
      if (c.profileId && c.profileId !== scope.profileId) continue; // only OUR profile, ever
      if (!c.platformCampaignId || !c.platformAdAccountId) continue;
      result.campaigns += 1;
      const externalAccountId = `${c.platform}:${c.platformAdAccountId}`;
      const account = await prisma.adAccount.upsert({
        where: { workspaceId_platformId_externalAccountId: { workspaceId: scope.workspaceId, platformId: platform.id, externalAccountId } },
        create: {
          workspaceId: scope.workspaceId,
          platformId: platform.id,
          externalAccountId,
          name: c.platformAdAccountName ?? c.platformAdAccountId,
          tokenRef: "zernio:platform-key",
          status: "connected",
        },
        update: { name: c.platformAdAccountName ?? c.platformAdAccountId, status: "connected" },
      });
      const budget = c.budget ?? c.campaignBudget ?? null;
      await prisma.paidAdCampaign.upsert({
        where: { workspaceId_accountId_externalId: { workspaceId: scope.workspaceId, accountId: account.id, externalId: c.platformCampaignId } },
        create: {
          workspaceId: scope.workspaceId,
          accountId: account.id,
          platformKey: "zernio",
          name: c.campaignName ?? c.platformCampaignId,
          objective: c.platform,
          externalId: c.platformCampaignId,
          status: campaignStatus(c.status),
          budgetCents: budget?.type === "lifetime" ? toMinorUnits(budget.amount, c.currency) : null,
        },
        update: {
          name: c.campaignName ?? c.platformCampaignId,
          status: campaignStatus(c.status),
          budgetCents: budget?.type === "lifetime" ? toMinorUnits(budget.amount, c.currency) : null,
        },
      });
      const r = await ingestAdReportRows({ workspaceId: scope.workspaceId, platformKey: "zernio", accountId: account.id, rows: normalizeZernioCampaign(c) });
      result.upserted += r.upserted;
      result.skippedNoCampaign += r.skippedNoCampaign;
    }
    if (!tree.pages || page >= tree.pages) break;
  }
  return result;
}
