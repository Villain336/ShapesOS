// Marketr — Phase 18 slice 4: Walmart Connect guided setup + spend import.
//
// OUTCOME B (research 2026-10-01 — see docs/phases/PHASE18-SLICE4-WALMART.md):
// Walmart Connect's Sponsored Search Ads API is exclusive to Walmart Connect
// Partner Network (WCPN) partners. There is no public OAuth authorize URL —
// auth is a single partner-level credential (Consumer ID + RSA-SHA256
// request signing + bearer token) issued after a BUSINESS application at
// advertising.walmart.com, which cannot be completed in code. So Walmart
// ships guided-only (same model as Spotify in spec §2d): this module owns
// the guided setup flow (partner-application checklist, placement planner
// with Vibe CTV, creative specs), manual advertiser-ID linking, external
// campaign registration, and the manual-or-CSV spend import into AdReport.
//
// Honest framing everywhere: "guided", never implied API control. Nothing
// here launches, pauses, or edits a campaign — spend happens in Walmart Ad
// Center; Marketr only tracks what the user imports.

import { prisma } from "@/lib/prisma";
import type { NormalizedAdRow, IngestAdReportInput } from "../reporting";
import type { AdsPlatformKey } from "../types";

export class WalmartGuidedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartGuidedError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Guided checklist: the WCPN partner-application path (for Tico / the org).
// ---------------------------------------------------------------------------

export interface WalmartGuidedStep {
  id: string;
  title: string;
  detail: string;
  /** Shell commands the user can copy (e.g. RSA keypair generation). */
  commands?: string[];
  /** Where the step happens. */
  link?: { label: string; href: string };
}

/**
 * The unlock path for the future API slice. Steps 1–2 require a human with
 * a Walmart.com account; nothing here is automatable from the server.
 */
export const WALMART_GUIDED_STEPS: WalmartGuidedStep[] = [
  {
    id: "partner-application",
    title: "Apply to the Walmart Connect Partner Network",
    detail:
      "Log in at advertising.walmart.com with a Walmart.com account (or create one), start the partner application, and choose the “Technology provider” partner type — “You offer advertisers a self-serve platform to manage ad campaigns, and want to integrate with Walmart Connect APIs.” Walmart reviews the application; watch for the approval email.",
    link: { label: "advertising.walmart.com", href: "https://advertising.walmart.com" },
  },
  {
    id: "rsa-keypair",
    title: "Generate an RSA-2048 keypair",
    detail:
      "Walmart signs every API request with RSA-SHA256. Generate a keypair locally and keep the private key somewhere safe — it will go into the Latchkey vault, never into code, chat, or logs.",
    commands: [
      "openssl genrsa -out walmart-partner-key.pem 2048",
      "openssl rsa -in walmart-partner-key.pem -pubout -out walmart-partner-public.pem",
    ],
  },
  {
    id: "upload-public-key",
    title: "Upload the public key to the Self-Serve Partner Onboarding Platform",
    detail:
      "In the developer portal's Self-Serve Partner Onboarding Platform, upload walmart-partner-public.pem. Walmart returns your Consumer ID, Auth Token, and Key Version. Ask for Full-Service API Partner access if you want campaign management (POST/PUT); Reporting Only gets GET + snapshot reports.",
    link: { label: "developer.walmart.com", href: "https://developer.walmart.com" },
  },
  {
    id: "store-in-vault",
    title: "Store the partner credential in the Latchkey vault",
    detail:
      "Once approved, the Consumer ID, Auth Token, Key Version, and private key go into the vault (a future slice wires the RSA-signing API client). Only an opaque tokenRef ever lands on the AdAccount row — the same scheme as the other platforms.",
  },
  {
    id: "grant-advertiser-access",
    title: "Have each advertiser grant the partner access",
    detail:
      "In Walmart Ad Center, each advertiser grants your WCPN partner access to their ad account and you note their advertiser ID. Link it below — that ID is what the future API client passes per call.",
  },
  {
    id: "launch-in-ad-center",
    title: "Launch campaigns in Walmart Ad Center (for now)",
    detail:
      "Until the API slice lands, campaigns are created in Walmart Ad Center: Sponsored Products, Sponsored Brands, Sponsored Video, and Vibe CTV. Register each campaign below with its Walmart campaign ID, then import spend via CSV — ShapesOS tracks everything you import.",
  },
];

// ---------------------------------------------------------------------------
// Placement planner: the four Phase-1 surfaces (spec §2c).
// ---------------------------------------------------------------------------

export interface WalmartPlacementOption {
  id: string;
  name: string;
  pricing: string;
  minimum: string;
  notes: string;
}

export const WALMART_PLACEMENT_OPTIONS: WalmartPlacementOption[] = [
  {
    id: "sponsored-products",
    name: "Sponsored Products",
    pricing: "CPC",
    minimum: "$0",
    notes: "Search, browse, and item-page placements. The workhorse for sellers.",
  },
  {
    id: "sponsored-brands",
    name: "Sponsored Brands",
    pricing: "CPC",
    minimum: "$0",
    notes: "Brand headline + logo + landing page. Requires an approved brand asset (specs below).",
  },
  {
    id: "sponsored-video",
    name: "Sponsored Video",
    pricing: "CPC",
    minimum: "$0",
    notes: "Video placements in search and browse. Upload video assets in Ad Center.",
  },
  {
    id: "vibe-ctv",
    name: "Vibe CTV",
    pricing: "CPM",
    minimum: "$0",
    notes: "Walmart's self-serve connected-TV placement — surfaced here as a planning option. Launch in Ad Center; spend imports the same way.",
  },
];

// ---------------------------------------------------------------------------
// Creative specs (Sponsored Brands brand asset — from the official API docs).
// ---------------------------------------------------------------------------

export interface WalmartCreativeSpec {
  asset: string;
  specs: string[];
}

export const WALMART_CREATIVE_SPECS: WalmartCreativeSpec[] = [
  {
    asset: "Sponsored Brands — brand asset",
    specs: [
      "Format: JPG or PNG, max 1 MB",
      "Aspect ratio 16:9, minimum 1200×628 px",
      "Headline: max 45 characters",
      "Shown as “Sponsored by <brand>” (max 35 characters)",
      "Click URL must be a walmart.com page showing the advertised brand's products (search, browse, brand shop, or brand shelf)",
    ],
  },
];

// ---------------------------------------------------------------------------
// Manual advertiser linking + external campaign registration.
// ---------------------------------------------------------------------------

/**
 * Link an advertiser's Walmart ad account by ID (manual — the advertiser
 * granted the WCPN partner access in Ad Center, or the user just wants to
 * track spend against the account). No token: tokenRef stays null and the
 * row sits in "pending" until a credential exists. Idempotent on
 * (workspace, platform, externalAccountId).
 */
export async function linkWalmartAdvertiserAccount(input: {
  workspaceId: string;
  name?: string;
  externalAccountId: string;
}) {
  const externalAccountId = input.externalAccountId.trim();
  if (!externalAccountId) {
    throw new WalmartGuidedError("INVALID_ACCOUNT_ID", "Advertiser ID is required");
  }
  const platform = await prisma.adPlatform.findFirst({
    where: { workspaceId: input.workspaceId, key: "walmart" satisfies AdsPlatformKey },
  });
  if (!platform) {
    throw new WalmartGuidedError("PLATFORM_MISSING", "Run ensureAdPlatforms first");
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
export type WalmartGuidedCampaignStatus = (typeof GUIDED_CAMPAIGN_STATUSES)[number];

function isGuidedCampaignStatus(value: string): value is WalmartGuidedCampaignStatus {
  return (GUIDED_CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

/**
 * Register a campaign that was launched in Walmart Ad Center, so imported
 * spend rows resolve to it. Status is the user-reported state (live/paused/
 * ended) — Marketr cannot read it from any API. Idempotent on
 * (workspace, account, externalId).
 */
export async function registerWalmartCampaign(input: {
  workspaceId: string;
  accountId: string;
  name: string;
  externalCampaignId: string;
  status: string;
  budgetCents?: number | null;
}) {
  const name = input.name.trim();
  const externalCampaignId = input.externalCampaignId.trim();
  if (!name) throw new WalmartGuidedError("INVALID_NAME", "Campaign name is required");
  if (!externalCampaignId) {
    throw new WalmartGuidedError("INVALID_CAMPAIGN_ID", "Walmart campaign ID is required");
  }
  if (!isGuidedCampaignStatus(input.status)) {
    throw new WalmartGuidedError(
      "INVALID_STATUS",
      `Status must be one of: ${GUIDED_CAMPAIGN_STATUSES.join(", ")}`,
    );
  }
  const account = await prisma.adAccount.findFirst({
    where: { id: input.accountId, workspaceId: input.workspaceId },
    include: { platform: { select: { key: true } } },
  });
  if (!account) throw new WalmartGuidedError("ACCOUNT_NOT_FOUND", "Ad account not found");
  if (account.platform.key !== "walmart") {
    throw new WalmartGuidedError("WRONG_PLATFORM", "That account is not a Walmart Connect account");
  }
  if (input.budgetCents !== undefined && input.budgetCents !== null) {
    if (!Number.isInteger(input.budgetCents) || input.budgetCents < 0) {
      throw new WalmartGuidedError("INVALID_BUDGET", "Budget must be a non-negative integer (cents)");
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
      platformKey: "walmart",
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

export const WALMART_CSV_COLUMNS = [
  "campaign_external_id",
  "date",
  "spend_cents",
  "impressions",
  "clicks",
  "conversions",
  "revenue_cents",
] as const;

export const WALMART_CSV_TEMPLATE = `${WALMART_CSV_COLUMNS.join(",")}\n12345678,2026-09-28,12500,8421,312,9,74900\n`;

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
    throw new WalmartGuidedError(
      "CSV_INVALID_NUMBER",
      `Line ${lineNo}: ${column} must be a non-negative integer (cents for money columns), got "${raw.trim()}"`,
    );
  }
  return Number(v);
}

function parseCsvDate(raw: string, lineNo: number): Date {
  const v = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new WalmartGuidedError("CSV_INVALID_DATE", `Line ${lineNo}: date must be YYYY-MM-DD, got "${raw.trim()}"`);
  }
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
    throw new WalmartGuidedError("CSV_INVALID_DATE", `Line ${lineNo}: "${v}" is not a real calendar date`);
  }
  return dt;
}

/**
 * Parse a Walmart spend CSV into normalized AdReport rows. Strict:
 * - header must contain every WALMART_CSV_COLUMNS entry (extra columns OK)
 * - every data line must have the same field count as the header
 * - dates must be real YYYY-MM-DD dates; money/counters non-negative ints
 * Failures throw WalmartGuidedError naming the exact line.
 */
export function parseWalmartSpendCsv(csv: string): NormalizedAdRow[] {
  const text = csv.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const dataLines: { no: number; line: string }[] = [];
  lines.forEach((line, i) => {
    if (line.trim() !== "") dataLines.push({ no: i + 1, line });
  });
  if (dataLines.length === 0) {
    throw new WalmartGuidedError("CSV_EMPTY", "The CSV is empty — paste the header row plus at least one data row");
  }
  const header = parseCsvLine(dataLines[0]!.line).map((h) => h.trim().toLowerCase());
  for (const col of WALMART_CSV_COLUMNS) {
    if (!header.includes(col)) {
      throw new WalmartGuidedError(
        "CSV_BAD_HEADER",
        `Missing required column "${col}" — expected: ${WALMART_CSV_COLUMNS.join(", ")}`,
      );
    }
  }
  const idx = (col: string) => header.indexOf(col);
  const rows: NormalizedAdRow[] = [];
  for (const { no, line } of dataLines.slice(1)) {
    const fields = parseCsvLine(line);
    if (fields.length !== header.length) {
      throw new WalmartGuidedError(
        "CSV_BAD_ROW",
        `Line ${no}: expected ${header.length} fields, got ${fields.length}`,
      );
    }
    const externalCampaignId = fields[idx("campaign_external_id")]!.trim();
    if (!externalCampaignId) {
      throw new WalmartGuidedError("CSV_BAD_ROW", `Line ${no}: campaign_external_id is required`);
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
    throw new WalmartGuidedError("CSV_EMPTY", "No data rows found after the header");
  }
  return rows;
}

/**
 * Build the ingest input for one CSV import batch. Pure (no DB) so the
 * import path is unit-testable; the caller feeds the result to
 * ingestAdReportRows(). Lineage: platformReceiptId = "import:<batchId>",
 * approvalId = null (manual import — no SpendApproval authorizes it).
 */
export function buildWalmartImportInput(input: {
  workspaceId: string;
  accountId: string;
  csv: string;
  batchId: string;
}): IngestAdReportInput {
  const rows = parseWalmartSpendCsv(input.csv).map((r) => ({
    ...r,
    platformReceiptId: `import:${input.batchId}`,
  }));
  return {
    workspaceId: input.workspaceId,
    platformKey: "walmart" satisfies AdsPlatformKey,
    accountId: input.accountId,
    rows,
  };
}
