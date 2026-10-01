// Marketr — Phase 18 slice 2: Amazon Ads reporting.
//
// Pulls the v3 async campaign performance report and normalizes rows into
// the slice-1 AdReport shape (lib/adplatforms/reporting.ts). Lineage on
// every row: report row → PaidAdCampaign → SpendApproval → platform
// receipt id (the async report id).
//
// Money: Amazon reports "cost"/"sales" in major currency units; the
// normalized rows carry minor units (cents).

import { prisma } from "@/lib/prisma";
import {
  ingestAdReportRows,
  type IngestAdReportResult,
  type NormalizedAdRow,
} from "../reporting";
import {
  AmazonAdsClient,
  AmazonAdsError,
  majorToCents,
  type AmazonReportAdProduct,
} from "./client";
import { resolveAmazonAuth } from "./tokens";

export interface AmazonRawReportRow {
  date?: string;
  campaignId?: string | number;
  campaignName?: string;
  impressions?: number;
  clicks?: number;
  /** Spend in major currency units. */
  cost?: number;
  purchases7d?: number;
  /** Attributed sales in major currency units. */
  sales7d?: number;
  [k: string]: unknown;
}

export interface NormalizeAmazonReportOptions {
  /** The async report id — becomes the row's platformReceiptId (lineage). */
  reportId?: string;
}

/**
 * Map raw Amazon report rows into NormalizedAdRow. Pure — tested without
 * network or DB. Rows with a missing/invalid date or campaign id throw
 * (fail closed: never normalize a row we cannot attribute).
 */
export function normalizeAmazonReportRows(
  raw: unknown,
  opts: NormalizeAmazonReportOptions = {},
): NormalizedAdRow[] {
  if (!Array.isArray(raw)) {
    throw new AmazonAdsError("BAD_RESPONSE", "Amazon report rows were not an array");
  }
  return (raw as AmazonRawReportRow[]).map((row, i) => {
    if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      throw new AmazonAdsError("BAD_RESPONSE", `Amazon report row ${i} has an invalid date`);
    }
    if (row.campaignId === undefined || row.campaignId === null || row.campaignId === "") {
      throw new AmazonAdsError("BAD_RESPONSE", `Amazon report row ${i} has no campaignId`);
    }
    const impressions = Number(row.impressions ?? 0);
    const clicks = Number(row.clicks ?? 0);
    const cost = Number(row.cost ?? 0);
    const purchases = Number(row.purchases7d ?? 0);
    const sales = Number(row.sales7d ?? 0);
    if ([impressions, clicks, cost, purchases, sales].some((n) => !Number.isFinite(n))) {
      throw new AmazonAdsError("BAD_RESPONSE", `Amazon report row ${i} has non-numeric metrics`);
    }
    return {
      externalCampaignId: String(row.campaignId),
      date: new Date(`${row.date}T00:00:00Z`),
      spendCents: majorToCents(cost),
      impressions: Math.round(impressions),
      clicks: Math.round(clicks),
      ctr: impressions > 0 ? clicks / impressions : null,
      conversions: purchases,
      revenueCents: majorToCents(sales),
      approvalId: null,
      platformReceiptId: opts.reportId ?? null,
      raw: row as Record<string, unknown>,
    } satisfies NormalizedAdRow;
  });
}

/** Find the SpendApproval behind an executed launch for a campaign. */
async function defaultFindApprovalId(
  workspaceId: string,
  externalCampaignId: string,
): Promise<string | null> {
  const proposal = await prisma.spendProposal.findFirst({
    where: { workspaceId, targetId: externalCampaignId, status: "executed", action: "launch" },
    orderBy: { decidedAt: "desc" },
    include: { approval: { select: { id: true } } },
  });
  return proposal?.approval?.id ?? null;
}

export interface PullAmazonReportDeps {
  workspaceId: string;
  accountId: string;
  /** YYYY-MM-DD. */
  startDate: string;
  /** YYYY-MM-DD. */
  endDate: string;
  adProduct?: AmazonReportAdProduct;
  fetchImpl?: typeof fetch;
  resolveAuth?: typeof resolveAmazonAuth;
  ingest?: typeof ingestAdReportRows;
  findApprovalId?: (workspaceId: string, externalCampaignId: string) => Promise<string | null>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface PullAmazonReportResult {
  reportId: string;
  rows: NormalizedAdRow[];
  ingested: IngestAdReportResult;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Request → poll → download → normalize → ingest one Amazon Ads campaign
 * performance report. Attaches the SpendApproval lineage per campaign.
 * Reads only — never gated.
 */
export async function pullAmazonReport(deps: PullAmazonReportDeps): Promise<PullAmazonReportResult> {
  const resolve = deps.resolveAuth ?? resolveAmazonAuth;
  const ingest = deps.ingest ?? ingestAdReportRows;
  const findApprovalId = deps.findApprovalId ?? defaultFindApprovalId;
  const { auth } = await resolve(deps.accountId);
  const client = new AmazonAdsClient({ auth, fetchImpl: deps.fetchImpl });

  const reportId = await client.requestCampaignReport({
    name: `marketr-campaign-${deps.startDate}`,
    startDate: deps.startDate,
    endDate: deps.endDate,
    adProduct: deps.adProduct ?? "SPONSORED_PRODUCTS",
  });

  const maxAttempts = deps.maxPollAttempts ?? 12;
  const intervalMs = deps.pollIntervalMs ?? 5000;
  let status = await client.getReportStatus(reportId);
  for (let attempt = 1; attempt < maxAttempts && status.status !== "COMPLETED"; attempt++) {
    if (status.status === "FAILURE") {
      throw new AmazonAdsError("REPORT_FAILED", `Amazon Ads report ${reportId} failed`);
    }
    await sleep(intervalMs);
    status = await client.getReportStatus(reportId);
  }
  if (status.status !== "COMPLETED") {
    throw new AmazonAdsError(
      "REPORT_TIMEOUT",
      `Amazon Ads report ${reportId} did not complete after ${maxAttempts} polls`,
    );
  }
  if (!status.url) {
    throw new AmazonAdsError("REPORT_FAILED", `Amazon Ads report ${reportId} completed with no download URL`);
  }

  const rawRows = await client.downloadReport(status.url);
  const rows = normalizeAmazonReportRows(rawRows, { reportId });
  for (const row of rows) {
    row.approvalId = await findApprovalId(deps.workspaceId, row.externalCampaignId);
  }
  const ingested = await ingest({
    workspaceId: deps.workspaceId,
    platformKey: "amazon",
    accountId: deps.accountId,
    rows,
  });
  return { reportId, rows, ingested };
}
