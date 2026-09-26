// Marketr — Phase 10 M6: SERP provider abstraction types.
// The interface every licensed retail SERP vendor adapter implements.
// Swapping vendors = swap the adapter behind this interface; consumers
// (fetchSerp) never touch vendor specifics. This is the §2 hedge.

export type SerpVendorId = "serper" | "dataforseo" | "talordata";

export interface SerpOrganicResult {
  position: number;
  url: string;
  domain: string;
  title: string;
}

export interface SerpResponse {
  keyword: string;
  locale: string;
  results: SerpOrganicResult[];
  /** Whether an AI Overview / answer block was detected on the page. */
  aiOverviewPresent: boolean;
  /** SERP feature tokens, e.g. "ai_overview", "featured_snippet", "people_also_ask", "local_pack". */
  serpFeatures: string[];
  fetchedAt: Date;
  vendor: SerpVendorId;
  /** USD cost of this call (single SERP pull). Never null — metering needs it. */
  costUsd: number;
}

export interface SerpSearchOpts {
  /** Request AI-Overview detection (routes to the vendor best at it). */
  needAiOverview?: boolean;
  /** Organic results to return (default 10). */
  numResults?: number;
}

/** Volume is ALWAYS a band — never a false-precision point value (§M5). */
export const VOLUME_BANDS = [
  "0–10",
  "10–100",
  "100–1K",
  "1K–10K",
  "10K–100K",
  "100K–1M",
  "1M+",
] as const;

export type VolumeBand = (typeof VOLUME_BANDS)[number];

/** A band must contain a range separator ("–") or a "+" — never a bare number. */
export function isVolumeBand(value: string): boolean {
  return VOLUME_BANDS.includes(value as VolumeBand);
}

/** Map a raw point volume (from a vendor panel) to the nearest band. */
export function pointToBand(point: number): VolumeBand {
  if (point < 10) return "0–10";
  if (point < 100) return "10–100";
  if (point < 1_000) return "100–1K";
  if (point < 10_000) return "1K–10K";
  if (point < 100_000) return "10K–100K";
  if (point < 1_000_000) return "100K–1M";
  return "1M+";
}

export interface SerpProvider {
  readonly vendor: SerpVendorId;
  /** True when credentials are present (data_source config or env). */
  isConfigured(): boolean;
  /** Cost of one SERP pull in USD (tier price / 1000). */
  costPerSerpCallUsd(): number;
  search(keyword: string, locale: string, opts?: SerpSearchOpts): Promise<SerpResponse>;
  /**
   * Volume capability (clickstream/panel bulk where the vendor offers it).
   * Optional — routing prefers vendors that implement it.
   */
  getVolumeBand?(keyword: string, locale: string): Promise<{ band: VolumeBand; costUsd: number }>;
}

/** Typed error: no credential anywhere (data_source config or env). */
export class VendorNotConfigured extends Error {
  readonly vendor: SerpVendorId;
  constructor(vendor: SerpVendorId) {
    super(
      `SERP vendor "${vendor}" is not configured: no credential in data_source config or env. ` +
        `Add an API key in Intelligence → Data sources, or set the vendor's env var for demo mode.`,
    );
    this.name = "VendorNotConfigured";
    this.vendor = vendor;
  }
}

/** Typed error: monthly budget cap would be exceeded. Never overspend. */
export class BudgetCapExceeded extends Error {
  readonly workspaceId: string;
  constructor(workspaceId: string, spendCents: number, capCents: number) {
    super(
      `Data budget cap reached for workspace ${workspaceId}: ` +
        `spent $${(spendCents / 100).toFixed(2)} of $${(capCents / 100).toFixed(2)} this period. ` +
        `Raise the cap in serp_vendor_config or pause data collection.`,
    );
    this.name = "BudgetCapExceeded";
    this.workspaceId = workspaceId;
  }
}

/** Typed error: Keyword Planner is not ready (stub path — see volume.ts). */
export class PlannerNotReady extends Error {
  constructor() {
    super(
      "Google Keyword Planner volume path is not configured yet. " +
        "Keyword Planner is free but requires a Google Ads manager account and a ~5-business-day " +
        "manual Basic-access review; Explorer access blocks KeywordPlanIdeaService. " +
        "See PLANNER_SETUP.md notes in lib/intelligence/providers/volume.ts. " +
        "Falling back to vendor clickstream bulk.",
    );
    this.name = "PlannerNotReady";
  }
}

/** Typed error: no volume source could serve this keyword right now. */
export class VolumeUnavailableError extends Error {
  constructor(keyword: string) {
    super(
      `No volume source available for "${keyword}": Keyword Planner is not set up and no ` +
        `clickstream vendor is configured. Configure a serp_vendor data source to enable volume lookups.`,
    );
    this.name = "VolumeUnavailableError";
  }
}
