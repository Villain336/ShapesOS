// Marketr — Phase 18 slice 1: AdReport normalization skeleton.
//
// Platform connectors (slices 2–5) map their raw exports into
// NormalizedAdRow via a per-platform normalize function, then call
// ingestAdReportRows() to upsert the daily rows. Lineage is preserved on
// every row: campaign → SpendApproval → platform receipt id.
//
// Slice 1 ships the schema + this entry point. No connector calls it yet.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AdsPlatformKey } from "./types";

/**
 * The normalized shape every platform maps into. Money in minor units
 * (cents); ctr as a fraction (0.021 = 2.1%); conversions may be fractional.
 */
export interface NormalizedAdRow {
  /** Platform-native campaign id — resolved to PaidAdCampaign on ingest. */
  externalCampaignId: string;
  /** The day these metrics describe (date portion only). */
  date: Date;
  spendCents: number;
  impressions: number;
  clicks: number;
  ctr?: number | null;
  conversions: number;
  revenueCents: number;
  /** Which SpendApproval authorized the spend behind these metrics. */
  approvalId?: string | null;
  /** The platform's own report/receipt id for this row. */
  platformReceiptId?: string | null;
  /** Raw platform row for audit/reconciliation. */
  raw?: Record<string, unknown>;
}

/** Per-platform normalizer, implemented by each connector slice. */
export type AdReportNormalizer = (raw: unknown) => NormalizedAdRow[];

const normalizers = new Map<AdsPlatformKey, AdReportNormalizer>();

/** Called by each platform connector slice to register its normalizer. */
export function registerAdReportNormalizer(platformKey: AdsPlatformKey, fn: AdReportNormalizer) {
  normalizers.set(platformKey, fn);
}

export function getAdReportNormalizer(platformKey: AdsPlatformKey): AdReportNormalizer | undefined {
  return normalizers.get(platformKey);
}

export class AdReportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdReportError";
    this.code = code;
  }
}

export interface IngestAdReportInput {
  workspaceId: string;
  platformKey: AdsPlatformKey;
  accountId: string;
  rows: NormalizedAdRow[];
}

export interface IngestAdReportResult {
  upserted: number;
  skippedNoCampaign: number;
}

/**
 * Upsert normalized daily rows. Rows whose external campaign id cannot be
 * resolved to a PaidAdCampaign are counted as skipped — never silently
 * dropped into the wrong campaign. Idempotent on (workspace, campaign, date).
 */
export async function ingestAdReportRows(
  input: IngestAdReportInput,
): Promise<IngestAdReportResult> {
  let upserted = 0;
  let skippedNoCampaign = 0;
  const account = await prisma.adAccount.findUnique({
    where: { id: input.accountId },
    select: { platformId: true },
  });
  if (!account) {
    throw new AdReportError("ACCOUNT_NOT_FOUND", `AdAccount ${input.accountId} not found`);
  }
  for (const row of input.rows) {
    const campaign = await prisma.paidAdCampaign.findFirst({
      where: {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        externalId: row.externalCampaignId,
      },
      select: { id: true },
    });
    if (!campaign) {
      skippedNoCampaign++;
      continue;
    }
    await prisma.adReport.upsert({
      where: {
        workspaceId_campaignId_date: {
          workspaceId: input.workspaceId,
          campaignId: campaign.id,
          date: row.date,
        },
      },
      update: {
        spendCents: row.spendCents,
        impressions: row.impressions,
        clicks: row.clicks,
        ctr: row.ctr ?? null,
        conversions: row.conversions,
        revenueCents: row.revenueCents,
        approvalId: row.approvalId ?? null,
        platformReceiptId: row.platformReceiptId ?? null,
        raw: (row.raw ?? {}) as Prisma.InputJsonValue,
      },
      create: {
        workspaceId: input.workspaceId,
        platformId: account.platformId,
        accountId: input.accountId,
        campaignId: campaign.id,
        date: row.date,
        spendCents: row.spendCents,
        impressions: row.impressions,
        clicks: row.clicks,
        ctr: row.ctr ?? null,
        conversions: row.conversions,
        revenueCents: row.revenueCents,
        approvalId: row.approvalId ?? null,
        platformReceiptId: row.platformReceiptId ?? null,
        raw: (row.raw ?? {}) as Prisma.InputJsonValue,
      },
    });
    upserted++;
  }
  return { upserted, skippedNoCampaign };
}

/** Read normalized rows for the UI/reporting surface. */
export async function listAdReportRows(input: {
  workspaceId: string;
  platformKey?: AdsPlatformKey;
  campaignId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}) {
  return prisma.adReport.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      ...(input.from || input.to
        ? { date: { gte: input.from, lte: input.to } }
        : {}),
      ...(input.platformKey
        ? { campaign: { platformKey: input.platformKey } }
        : {}),
    },
    orderBy: { date: "desc" },
    take: input.limit ?? 100,
    include: { campaign: { select: { name: true, platformKey: true } } },
  });
}
