// Marketr — Phase 18 slice 5: Spotify guided setup + spend import.
//
// Spotify is guided-only BY DESIGN (spec §2d, Tico-locked 2026-09-29): the
// self-serve path is Spotify Ads Manager / Ad Studio — there is no public
// self-serve campaign-launch API for a third-party SaaS to OAuth into.
// So this module owns the guided setup flow (account checklist,
// audience/geo/budget planner with the $250 minimum floor, audio creative
// spec checker, UTM + pixel templates), manual ad-account linking, external
// campaign registration, and the manual-or-CSV spend import into AdReport.
//
// 2026-10-01 research note: Spotify publishes a public `ads-agentic-tools`
// repo (github.com/spotify/ads-agentic-tools) documenting an Ads API v3
// (OAuth 2.0 + PKCE, draft/publish campaign endpoints). Access still
// appears partner/beta-gated (see docs/phases/PHASE18-SLICE5-SPOTIFY.md),
// and the self-serve path remains Ads Manager — so the guided flow stands.
// If the v3 API opens to self-serve advertisers, a follow-up slice adds a
// direct connector (same unlock-path pattern as Walmart slice 4).
//
// Honest framing everywhere: "guided", never implied API control. Nothing
// here launches, pauses, or edits a campaign — spend happens in Spotify
// Ads Manager; Marketr only tracks what the user imports. The DSP route
// (programmatic Spotify audio) is available via the StackAdapt connector
// (slice 3) and is cross-linked in the UI copy as the programmatic
// alternative — not a fake integration.

import { prisma } from "@/lib/prisma";
import type { NormalizedAdRow, IngestAdReportInput } from "../reporting";
import type { AdsPlatformKey } from "../types";
// Local binding (export * alone does not bind the name in this module).
import { SpotifyGuidedError } from "./planning";

// Pure planning primitives (budget planner, creative checker, UTM builder,
// pixel template, checklist data) live in ./planning.ts — prisma-free so
// client components can import them. Re-exported here so existing imports
// from "../guided" keep working.
export * from "./planning";

// ---------------------------------------------------------------------------
// Manual ad-account linking + external campaign registration.
// ---------------------------------------------------------------------------

/**
 * Link an advertiser's Spotify ad account by ID (manual — the user copies
 * it from Spotify Ads Manager). No credential is stored; tokenRef stays
 * null and the row sits in "pending". Idempotent on
 * (workspace, platform, externalAccountId).
 */
export async function linkSpotifyAdAccount(input: {
  workspaceId: string;
  name?: string;
  externalAccountId: string;
}) {
  const externalAccountId = input.externalAccountId.trim();
  if (!externalAccountId) {
    throw new SpotifyGuidedError("INVALID_ACCOUNT_ID", "Ad account ID is required");
  }
  const platform = await prisma.adPlatform.findFirst({
    where: { workspaceId: input.workspaceId, key: "spotify" satisfies AdsPlatformKey },
  });
  if (!platform) {
    throw new SpotifyGuidedError("PLATFORM_MISSING", "Run ensureAdPlatforms first");
  }
  return prisma.adAccount.upsert({
    where: {
      workspaceId_platformId_externalAccountId: {
        workspaceId: input.workspaceId,
        platformId: platform.id,
        externalAccountId,
      },
    },
    update: { name: input.name?.trim() || undefined, status: "pending" },
    create: {
      workspaceId: input.workspaceId,
      platformId: platform.id,
      name: input.name?.trim() || null,
      externalAccountId,
      tokenRef: null,
      status: "pending",
    },
  });
}

const GUIDED_CAMPAIGN_STATUSES = ["live", "paused", "ended"] as const;
export type SpotifyGuidedCampaignStatus = (typeof GUIDED_CAMPAIGN_STATUSES)[number];

function isGuidedCampaignStatus(value: string): value is SpotifyGuidedCampaignStatus {
  return (GUIDED_CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

/**
 * Register a campaign that was launched in Spotify Ads Manager, so imported
 * spend rows resolve to it. Status is the user-reported state (live/paused/
 * ended) — Marketr cannot read it from any API. Idempotent on
 * (workspace, account, externalId).
 */
export async function registerSpotifyCampaign(input: {
  workspaceId: string;
  accountId: string;
  name: string;
  externalCampaignId: string;
  status: string;
  budgetCents?: number | null;
}) {
  const name = input.name.trim();
  const externalCampaignId = input.externalCampaignId.trim();
  if (!name) throw new SpotifyGuidedError("INVALID_NAME", "Campaign name is required");
  if (!externalCampaignId) {
    throw new SpotifyGuidedError("INVALID_CAMPAIGN_ID", "Spotify campaign ID is required");
  }
  if (!isGuidedCampaignStatus(input.status)) {
    throw new SpotifyGuidedError(
      "INVALID_STATUS",
      `Status must be one of: ${GUIDED_CAMPAIGN_STATUSES.join(", ")}`,
    );
  }
  const account = await prisma.adAccount.findFirst({
    where: { id: input.accountId, workspaceId: input.workspaceId },
    include: { platform: { select: { key: true } } },
  });
  if (!account) throw new SpotifyGuidedError("ACCOUNT_NOT_FOUND", "Ad account not found");
  if (account.platform.key !== "spotify") {
    throw new SpotifyGuidedError("WRONG_PLATFORM", "That account is not a Spotify ad account");
  }
  if (input.budgetCents !== undefined && input.budgetCents !== null) {
    if (!Number.isInteger(input.budgetCents) || input.budgetCents < 0) {
      throw new SpotifyGuidedError("INVALID_BUDGET", "Budget must be a non-negative integer (cents)");
    }
  }
  return prisma.paidAdCampaign.upsert({
    where: {
      workspaceId_accountId_externalId: {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        externalId: externalCampaignId,
      },
    },
    update: {
      name,
      status: input.status,
      budgetCents: input.budgetCents ?? null,
    },
    create: {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      platformKey: "spotify",
      name,
      externalId: externalCampaignId,
      status: input.status,
      budgetCents: input.budgetCents ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Manual-or-CSV spend import → AdReport.
// ---------------------------------------------------------------------------

export const SPOTIFY_CSV_COLUMNS = [
  "campaign_external_id",
  "date",
  "spend_cents",
  "impressions",
  "clicks",
  "conversions",
  "revenue_cents",
] as const;

export const SPOTIFY_CSV_TEMPLATE = `${SPOTIFY_CSV_COLUMNS.join(",")}\nsp_9f3a2c,2026-09-28,12500,8421,312,9,74900\n`;

function parseCsvLine(line: string): string[] {
  // Minimal RFC-4180: quoted fields with "" escapes, commas inside quotes.
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseNonNegativeInt(raw: string, column: string, lineNo: number): number {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) {
    throw new SpotifyGuidedError(
      "CSV_INVALID_NUMBER",
      `Line ${lineNo}: ${column} must be a non-negative integer (cents for money columns), got "${raw.trim()}"`,
    );
  }
  return Number(v);
}

function parseCsvDate(raw: string, lineNo: number): Date {
  const v = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new SpotifyGuidedError("CSV_INVALID_DATE", `Line ${lineNo}: date must be YYYY-MM-DD, got "${raw.trim()}"`);
  }
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
    throw new SpotifyGuidedError("CSV_INVALID_DATE", `Line ${lineNo}: "${v}" is not a real calendar date`);
  }
  return dt;
}

/**
 * Parse a Spotify spend CSV into normalized AdReport rows. Strict:
 * - header must contain every SPOTIFY_CSV_COLUMNS entry (extra columns OK)
 * - every data line must have the same field count as the header
 * - dates must be real YYYY-MM-DD dates; money/counters non-negative ints
 * Failures throw SpotifyGuidedError naming the exact line.
 */
export function parseSpotifySpendCsv(csv: string): NormalizedAdRow[] {
  const text = csv.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const dataLines: { no: number; line: string }[] = [];
  lines.forEach((line, i) => {
    if (line.trim() !== "") dataLines.push({ no: i + 1, line });
  });
  if (dataLines.length === 0) {
    throw new SpotifyGuidedError("CSV_EMPTY", "The CSV is empty — paste the header row plus at least one data row");
  }
  const header = parseCsvLine(dataLines[0]!.line).map((h) => h.trim().toLowerCase());
  for (const col of SPOTIFY_CSV_COLUMNS) {
    if (!header.includes(col)) {
      throw new SpotifyGuidedError(
        "CSV_BAD_HEADER",
        `Missing required column "${col}" — expected: ${SPOTIFY_CSV_COLUMNS.join(", ")}`,
      );
    }
  }
  const idx = (col: string) => header.indexOf(col);
  const rows: NormalizedAdRow[] = [];
  for (const { no, line } of dataLines.slice(1)) {
    const fields = parseCsvLine(line);
    if (fields.length !== header.length) {
      throw new SpotifyGuidedError(
        "CSV_BAD_ROW",
        `Line ${no}: expected ${header.length} fields, got ${fields.length}`,
      );
    }
    const externalCampaignId = fields[idx("campaign_external_id")]!.trim();
    if (!externalCampaignId) {
      throw new SpotifyGuidedError("CSV_BAD_ROW", `Line ${no}: campaign_external_id is required`);
    }
    const date = parseCsvDate(fields[idx("date")]!, no);
    const spendCents = parseNonNegativeInt(fields[idx("spend_cents")]!, "spend_cents", no);
    const impressions = parseNonNegativeInt(fields[idx("impressions")]!, "impressions", no);
    const clicks = parseNonNegativeInt(fields[idx("clicks")]!, "clicks", no);
    const conversions = parseNonNegativeInt(fields[idx("conversions")]!, "conversions", no);
    const revenueCents = parseNonNegativeInt(fields[idx("revenue_cents")]!, "revenue_cents", no);
    rows.push({
      externalCampaignId,
      date,
      spendCents,
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : null,
      conversions,
      revenueCents,
      approvalId: null,
      platformReceiptId: null,
      raw: { source: "csv", line: no },
    });
  }
  if (rows.length === 0) {
    throw new SpotifyGuidedError("CSV_EMPTY", "No data rows found after the header");
  }
  return rows;
}

/**
 * Build the ingest input for one CSV import batch. Pure (no DB) so the
 * import path is unit-testable; the caller feeds the result to
 * ingestAdReportRows(). Lineage: platformReceiptId = "import:<batchId>",
 * approvalId = null (manual import — no SpendApproval authorizes it).
 */
export function buildSpotifyImportInput(input: {
  workspaceId: string;
  accountId: string;
  csv: string;
  batchId: string;
}): IngestAdReportInput {
  const rows = parseSpotifySpendCsv(input.csv).map((r) => ({
    ...r,
    platformReceiptId: `import:${input.batchId}`,
  }));
  return {
    workspaceId: input.workspaceId,
    platformKey: "spotify" satisfies AdsPlatformKey,
    accountId: input.accountId,
    rows,
  };
}
