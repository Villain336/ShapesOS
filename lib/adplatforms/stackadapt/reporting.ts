// Marketr — Phase 18 slice 3: StackAdapt reporting.
//
// Pulls the GraphQL campaignDelivery records and normalizes them into the
// slice-1 AdReport shape (lib/adplatforms/reporting.ts). Lineage on every
// row: report row → PaidAdCampaign → SpendApproval → platform receipt id.
//
// Money: StackAdapt reports cost/revenue as MoneyValue decimal strings in
// major units; the normalized rows carry minor units (cents).
//
// The campaignDelivery query shape is MODELED on the public docs and is
// unverified against the live schema — the client fails closed with
// UNVERIFIED_REPORTING_QUERY rather than ingesting unshaped data.

import { prisma } from "@/lib/prisma";
import {
  ingestAdReportRows,
  type IngestAdReportResult,
  type NormalizedAdRow,
} from "../reporting";
import { StackAdaptClient, StackAdaptError, majorStringToCents, type StackAdaptDeliveryRecord } from "./client";
import { resolveStackAdaptKey } from "./keys";

export interface NormalizeStackAdaptReportOptions {
  /** Becomes the row's platformReceiptId (lineage). */
  reportId?: string;
}

/**
 * Map raw StackAdapt delivery records into NormalizedAdRow. Pure — tested
 * without network or DB. Rows with a missing/invalid date or campaign id
 * throw (fail closed: never normalize a row we cannot attribute).
 */
export function normalizeStackAdaptReportRows(
  raw: unknown,
  opts: NormalizeStackAdaptReportOptions = {},
): NormalizedAdRow[] {
  if (!Array.isArray(raw)) {
    throw new StackAdaptError("BAD_RESPONSE", "StackAdapt delivery records were not an array");
  }
  return (raw as StackAdaptDeliveryRecord[]).map((row, i) => {
    if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      throw new StackAdaptError("BAD_RESPONSE", `StackAdapt delivery record ${i} has an invalid date`);
    }
    if (typeof row.campaignId !== "string" || !row.campaignId) {
      throw new StackAdaptError("BAD_RESPONSE", `StackAdapt delivery record ${i} has no campaign id`);
    }
    const impressions = Number(row.impressions ?? 0);
    const clicks = Number(row.clicks ?? 0);
    const conversions = Number(row.conversions ?? 0);
    if ([impressions, clicks, conversions].some((n) => !Number.isFinite(n))) {
      throw new StackAdaptError("BAD_RESPONSE", `StackAdapt delivery record ${i} has non-numeric metrics`);
    }
    return {
      externalCampaignId: row.campaignId,
      date: new Date(`${row.date}T00:00:00Z`),
      spendCents: majorStringToCents(String(row.cost ?? "0")),
      impressions: Math.round(impressions),
      clicks: Math.round(clicks),
      ctr: impressions > 0 ? clicks / impressions : null,
      conversions,
      revenueCents: majorStringToCents(String(row.revenue ?? "0")),
      approvalId: null,
      platformReceiptId: opts.reportId ?? null,
      raw: row as unknown as Record<string, unknown>,
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

export interface PullStackAdaptReportDeps {
  workspaceId: string;
  accountId: string;
  /** YYYY-MM-DD. */
  startDate: string;
  /** YYYY-MM-DD. */
  endDate: string;
  campaignIds?: string[];
  fetchImpl?: typeof fetch;
  resolveKey?: typeof resolveStackAdaptKey;
  ingest?: typeof ingestAdReportRows;
  findApprovalId?: (workspaceId: string, externalCampaignId: string) => Promise<string | null>;
}

export interface PullStackAdaptReportResult {
  rows: NormalizedAdRow[];
  ingested: IngestAdReportResult;
}

/**
 * Pull → normalize → ingest one StackAdapt delivery pull. Attaches the
 * SpendApproval lineage per campaign. Reads only — never gated.
 */
export async function pullStackAdaptReport(
  deps: PullStackAdaptReportDeps,
): Promise<PullStackAdaptReportResult> {
  const resolve = deps.resolveKey ?? resolveStackAdaptKey;
  const ingest = deps.ingest ?? ingestAdReportRows;
  const findApprovalId = deps.findApprovalId ?? defaultFindApprovalId;
  const { apiKey } = await resolve(deps.accountId);
  const client = new StackAdaptClient({ auth: { apiKey }, fetchImpl: deps.fetchImpl });

  const records: StackAdaptDeliveryRecord[] = [];
  let after: string | undefined;
  do {
    const page = await client.campaignDelivery({
      campaignIds: deps.campaignIds,
      startDate: deps.startDate,
      endDate: deps.endDate,
      after,
    });
    records.push(...page.nodes);
    after = page.hasNextPage ? (page.endCursor ?? undefined) : undefined;
  } while (after);

  const rows = normalizeStackAdaptReportRows(records, {
    reportId: `stackadapt:${deps.startDate}:${deps.endDate}`,
  });
  for (const row of rows) {
    row.approvalId = await findApprovalId(deps.workspaceId, row.externalCampaignId);
  }
  const ingested = await ingest({
    workspaceId: deps.workspaceId,
    platformKey: "stackadapt",
    accountId: deps.accountId,
    rows,
  });
  return { rows, ingested };
}
