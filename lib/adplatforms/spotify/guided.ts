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

export class SpotifyGuidedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SpotifyGuidedError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Guided checklist: the Ads Manager account path (for Tico / the org).
// Source: https://ads.spotify.com/en-NL/help-center/getting-started-with-ad-studio/
// ---------------------------------------------------------------------------

export interface SpotifyGuidedStep {
  id: string;
  title: string;
  detail: string;
  /** Where the step happens. */
  link?: { label: string; href: string };
}

/**
 * The self-serve account path. Steps 1–6 require a human with a Spotify
 * account; nothing here is automatable from the server.
 */
export const SPOTIFY_GUIDED_STEPS: SpotifyGuidedStep[] = [
  {
    id: "spotify-account",
    title: "Create a Spotify account with a business email",
    detail:
      "Ad Studio needs a Spotify account. Create a free Spotify account with a team business email or alias (not a personal account) so all stakeholders stay looped in on the ad account.",
    link: { label: "Getting started with Ad Studio", href: "https://ads.spotify.com/en-NL/help-center/getting-started-with-ad-studio/" },
  },
  {
    id: "ad-studio-account",
    title: "Create your Spotify Ad Studio account",
    detail:
      "Sign up for Ad Studio and log in with the Spotify account from step 1. Ad Studio is Spotify's self-serve platform: build an audio or video campaign in minutes, forecast impression estimates, and read campaign reports.",
    link: { label: "Getting started with Ad Studio", href: "https://ads.spotify.com/en-NL/help-center/getting-started-with-ad-studio/" },
  },
  {
    id: "ad-account",
    title: "Create an ad account under Ad Studio",
    detail:
      "You can have multiple ad accounts under one Ad Studio account. From the left-hand navigation go to Manage ad accounts → +Ad accounts and create one per client or brand. Note the ad account ID — you'll link it in Marketr below.",
    link: { label: "Getting started with Ad Studio", href: "https://ads.spotify.com/en-NL/help-center/getting-started-with-ad-studio/" },
  },
  {
    id: "team-permissions",
    title: "Add your team and set permissions",
    detail:
      "Add teammates to the ad account: Admin (the account creator — creates/edits/exports campaigns and is the only role that edits account settings and payment details), contributors, and viewers.",
    link: { label: "Getting started with Ad Studio", href: "https://ads.spotify.com/en-NL/help-center/getting-started-with-ad-studio/" },
  },
  {
    id: "billing",
    title: "Set up billing on the advertiser's own card",
    detail:
      "Add the advertiser's payment method in the Ad Studio account settings (Admin role required). Marketr never holds or moves ad money — spend is always billed to the advertiser's own card.",
  },
  {
    id: "launch-in-ads-manager",
    title: "Plan and launch your campaign in Spotify Ads Manager",
    detail:
      "Define your audience (demographics, location, interests and genres, real-time listening context), set a lifetime budget of at least $250, upload an audio ad that passes the creative specs below, and launch. Use the planner section on this page to sanity-check the budget first.",
    link: { label: "Using Spotify's self-serve Ad Manager", href: "https://ads.spotify.com/en-NL/how-it-works/" },
  },
  {
    id: "register-and-import",
    title: "Register the campaign and import spend in Marketr",
    detail:
      "Marketr has no API view into your Spotify campaigns, so register each launched campaign below with its Spotify campaign ID, then import daily spend via CSV — Marketr tracks everything you import.",
  },
];

// ---------------------------------------------------------------------------
// Budget planner: the $250 minimum floor, enforced as a planner rule.
// Source: https://ads.spotify.com/en-NL/help-center/getting-started-with-ad-studio/
// ("Launch a campaign with a minimum budget of 250.00 in your local currency")
// ---------------------------------------------------------------------------

/** Spotify Ad Studio minimum lifetime campaign budget, USD. */
export const SPOTIFY_MIN_BUDGET_USD = 250;

export interface SpotifyBudgetPlanInput {
  /** Lifetime budget in USD. */
  budgetUsd: number;
  /** Flight start, YYYY-MM-DD (optional). */
  startDate?: string;
  /** Flight end, YYYY-MM-DD (optional). */
  endDate?: string;
}

export interface SpotifyBudgetPlan {
  ok: boolean;
  budgetCents: number;
  belowMinimum: boolean;
  minimumUsd: number;
  /** Inclusive flight days, or null when the dates are missing/invalid. */
  flightDays: number | null;
  /** Estimated daily spend in USD, or null when unknowable. */
  estimatedDailyUsd: number | null;
  /** Honest planner notes — never a promise of delivery. */
  notes: string[];
}

function parsePlanDate(raw: string | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/**
 * Pure budget planner. The $250 Ad Studio minimum is a floor, not a
 * suggestion: plans below it are flagged (ok: false) with honest messaging
 * about why the campaign cannot launch as planned.
 */
export function planSpotifyBudget(input: SpotifyBudgetPlanInput): SpotifyBudgetPlan {
  const notes: string[] = [];
  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) {
    throw new SpotifyGuidedError("INVALID_BUDGET", "Budget must be a positive number (USD)");
  }
  const budgetCents = Math.round(input.budgetUsd * 100);
  const belowMinimum = input.budgetUsd < SPOTIFY_MIN_BUDGET_USD;

  const start = parsePlanDate(input.startDate);
  const end = parsePlanDate(input.endDate);
  let flightDays: number | null = null;
  if (start && end) {
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days >= 1) flightDays = days;
    else notes.push("The end date is before the start date — check the flight dates.");
  } else if ((input.startDate && !start) || (input.endDate && !end)) {
    notes.push("A flight date wasn't a real YYYY-MM-DD date, so no daily estimate was computed.");
  }

  const estimatedDailyUsd =
    flightDays !== null ? Math.round((input.budgetUsd / flightDays) * 100) / 100 : null;

  if (belowMinimum) {
    notes.push(
      `Below the Ad Studio minimum: Spotify requires a lifetime budget of at least $${SPOTIFY_MIN_BUDGET_USD} ` +
        `(in your local currency). A $${input.budgetUsd.toFixed(2)} plan cannot launch as-is — raise the budget to $${SPOTIFY_MIN_BUDGET_USD} or more.`,
    );
  } else {
    notes.push(
      `Meets the $${SPOTIFY_MIN_BUDGET_USD} Ad Studio minimum. Pricing depends on the ad format you choose, ` +
        `and you can adjust frequency caps in real time after launch.`,
    );
  }
  if (flightDays !== null && estimatedDailyUsd !== null) {
    notes.push(
      `≈ $${estimatedDailyUsd.toFixed(2)}/day over ${flightDays} day${flightDays === 1 ? "" : "s"} — a planning estimate, not a delivery promise.`,
    );
  }
  notes.push(
    "Programmatic alternative: Spotify audio inventory can also be bought programmatically through the StackAdapt connector (Advertising hub) instead of Ad Studio.",
  );

  return {
    ok: !belowMinimum,
    budgetCents,
    belowMinimum,
    minimumUsd: SPOTIFY_MIN_BUDGET_USD,
    flightDays,
    estimatedDailyUsd,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Audio creative specs — from Spotify's official ad specs pages (2026-10-01).
// ---------------------------------------------------------------------------

export const SPOTIFY_AUDIO_SPEC_SOURCES = [
  "https://ads.spotify.com/en-CA/help-center/audio-ad-creative/",
  "https://ads.spotify.com/en-IN/ad-experiences/audio-ads-specs/",
] as const;

export interface SpotifyAudioSpecGroup {
  asset: string;
  source: string;
  specs: string[];
}

export const SPOTIFY_AUDIO_SPECS: SpotifyAudioSpecGroup[] = [
  {
    asset: "Audio ad file",
    source: "https://ads.spotify.com/en-CA/help-center/audio-ad-creative/",
    specs: [
      "Length: 30 seconds or less",
      "File types: WAV, MP3, OGG",
      "Max file size: 1 MB (Ad Studio)",
      "WAV: 16-bit, 44.1 kHz · MP3: at least 192 kbps · RMS normalized to 14 dBFS, peak to -0.2 dBFS",
      "Stereo; overall loudness -16 LUFS (±1.5), true peak ≤ -2.0 dBTP",
      "Script: no more than 65 words for a 30-second ad; advertiser name ≤ 25 characters",
    ],
  },
  {
    asset: "Companion image",
    source: "https://ads.spotify.com/en-CA/help-center/audio-ad-creative/",
    specs: [
      "Square, at least 640 × 640 pixels",
      "File type: JPEG or PNG",
      "Max file size: 200 KB",
    ],
  },
];

const SPOTIFY_AUDIO_EXTENSIONS = ["wav", "mp3", "ogg"] as const;
const SPOTIFY_MAX_AUDIO_BYTES = 1 * 1024 * 1024;
const SPOTIFY_MAX_AUDIO_SECONDS = 30;
const SPOTIFY_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png"] as const;
const SPOTIFY_MIN_IMAGE_PX = 640;
const SPOTIFY_MAX_IMAGE_BYTES = 200 * 1024;
const SPOTIFY_MAX_SCRIPT_WORDS = 65;

export interface SpotifyAudioCreativeInput {
  fileName: string;
  fileSizeBytes: number;
  /** null = the user didn't provide it — reported as "couldn't verify". */
  durationSeconds: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  imageExt: string;
  imageSizeBytes: number | null;
  scriptWords: number | null;
}

export interface SpotifySpecCheck {
  rule: string;
  /** null = could not be verified from the info given (not a pass). */
  pass: boolean | null;
  detail: string;
}

/**
 * Check an audio creative against the official Ad Studio specs. Pure and
 * honest: anything the caller didn't supply comes back as pass: null with
 * a "provide X" note — never assumed.
 */
export function checkSpotifyAudioCreative(input: SpotifyAudioCreativeInput): SpotifySpecCheck[] {
  const ext = input.fileName.split(".").pop()?.toLowerCase() ?? "";
  const imageExt = input.imageExt.replace(/^\./, "").toLowerCase();
  const checks: SpotifySpecCheck[] = [];

  checks.push({
    rule: "Audio format",
    pass: (SPOTIFY_AUDIO_EXTENSIONS as readonly string[]).includes(ext),
    detail: (SPOTIFY_AUDIO_EXTENSIONS as readonly string[]).includes(ext)
      ? `.${ext} is accepted (WAV, MP3, OGG)`
      : `.${ext || "(none)"} is not accepted — Ad Studio takes WAV, MP3, or OGG`,
  });

  checks.push({
    rule: "Audio file size",
    pass: input.fileSizeBytes <= SPOTIFY_MAX_AUDIO_BYTES,
    detail:
      input.fileSizeBytes <= SPOTIFY_MAX_AUDIO_BYTES
        ? `${(input.fileSizeBytes / 1024).toFixed(0)} KB is within the 1 MB Ad Studio limit`
        : `${(input.fileSizeBytes / 1024 / 1024).toFixed(2)} MB exceeds the 1 MB Ad Studio limit`,
  });

  checks.push({
    rule: "Audio duration",
    pass: input.durationSeconds === null ? null : input.durationSeconds <= SPOTIFY_MAX_AUDIO_SECONDS,
    detail:
      input.durationSeconds === null
        ? "Duration not provided — Spotify accepts 30 seconds or less; check your file's duration"
        : input.durationSeconds <= SPOTIFY_MAX_AUDIO_SECONDS
          ? `${input.durationSeconds}s is within the 30-second limit`
          : `${input.durationSeconds}s exceeds the 30-second limit`,
  });

  checks.push({
    rule: "Companion image is square",
    pass: input.imageWidth === null || input.imageHeight === null ? null : input.imageWidth === input.imageHeight,
    detail:
      input.imageWidth === null || input.imageHeight === null
        ? "Image dimensions not provided — the companion image must be square"
        : input.imageWidth === input.imageHeight
          ? `${input.imageWidth}×${input.imageHeight} is square`
          : `${input.imageWidth}×${input.imageHeight} is not square — the companion image must be square`,
  });

  checks.push({
    rule: "Companion image size",
    pass:
      input.imageWidth === null || input.imageHeight === null
        ? null
        : input.imageWidth >= SPOTIFY_MIN_IMAGE_PX && input.imageHeight >= SPOTIFY_MIN_IMAGE_PX,
    detail:
      input.imageWidth === null || input.imageHeight === null
        ? "Image dimensions not provided — at least 640 × 640 px required"
        : input.imageWidth >= SPOTIFY_MIN_IMAGE_PX && input.imageHeight >= SPOTIFY_MIN_IMAGE_PX
          ? `${input.imageWidth}×${input.imageHeight} meets the 640 × 640 minimum`
          : `${input.imageWidth}×${input.imageHeight} is below the 640 × 640 minimum`,
  });

  checks.push({
    rule: "Companion image format",
    pass: (SPOTIFY_IMAGE_EXTENSIONS as readonly string[]).includes(imageExt),
    detail: (SPOTIFY_IMAGE_EXTENSIONS as readonly string[]).includes(imageExt)
      ? `.${imageExt} is accepted (JPEG or PNG)`
      : `.${imageExt || "(none)"} is not accepted — JPEG or PNG only`,
  });

  checks.push({
    rule: "Companion image file size",
    pass: input.imageSizeBytes === null ? null : input.imageSizeBytes <= SPOTIFY_MAX_IMAGE_BYTES,
    detail:
      input.imageSizeBytes === null
        ? "Image file size not provided — 200 KB maximum"
        : input.imageSizeBytes <= SPOTIFY_MAX_IMAGE_BYTES
          ? `${(input.imageSizeBytes / 1024).toFixed(0)} KB is within the 200 KB limit`
          : `${(input.imageSizeBytes / 1024).toFixed(0)} KB exceeds the 200 KB limit`,
  });

  checks.push({
    rule: "Script length",
    pass: input.scriptWords === null ? null : input.scriptWords <= SPOTIFY_MAX_SCRIPT_WORDS,
    detail:
      input.scriptWords === null
        ? "Word count not provided — Spotify recommends ≤ 65 words for a 30-second ad"
        : input.scriptWords <= SPOTIFY_MAX_SCRIPT_WORDS
          ? `${input.scriptWords} words is within the 65-word recommendation`
          : `${input.scriptWords} words exceeds the 65-word recommendation for 30 seconds`,
  });

  return checks;
}

// ---------------------------------------------------------------------------
// UTM builder — utm_source=spotify fixed. Spotify appends `spclid` to ad
// landing URLs (per spotify/ads-agentic-tools measurement docs), so the
// builder preserves existing params and the UI reminds users to keep query
// params intact through redirects.
// ---------------------------------------------------------------------------

export interface SpotifyUtmInput {
  baseUrl: string;
  campaign: string;
  /** Defaults to "audio". */
  medium?: string;
  /** Optional ad/content differentiator. */
  content?: string;
}

/**
 * Build a tagged landing URL for a Spotify campaign. Throws
 * SpotifyGuidedError on a missing/invalid base URL or empty campaign name.
 */
export function buildSpotifyUtmUrl(input: SpotifyUtmInput): string {
  const campaign = input.campaign.trim();
  if (!campaign) throw new SpotifyGuidedError("INVALID_UTM", "Campaign name is required for the UTM tag");
  let url: URL;
  try {
    url = new URL(input.baseUrl.trim());
  } catch {
    throw new SpotifyGuidedError("INVALID_UTM", "Base URL must be a valid absolute URL (https://…)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SpotifyGuidedError("INVALID_UTM", "Base URL must be http(s)");
  }
  url.searchParams.set("utm_source", "spotify");
  url.searchParams.set("utm_medium", (input.medium ?? "audio").trim() || "audio");
  url.searchParams.set("utm_campaign", campaign);
  const content = input.content?.trim();
  if (content) url.searchParams.set("utm_content", content);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Spotify Pixel template (REFERENCE SHAPE ONLY).
//
// The canonical base code + Pixel ID come from Ad Studio → the Events/Pixel
// section of your ad account. The shape below is documented in third-party
// Spotify-ads implementation guides (e.g. bluefroganalytics.com Spotify Ads
// docs) — treat it as a starting template, not the verbatim snippet.
// ---------------------------------------------------------------------------

export const SPOTIFY_PIXEL_TEMPLATE = `<!-- Spotify Pixel base code — REFERENCE TEMPLATE.
     Get your canonical snippet + Pixel ID from Ad Studio → Events/Pixel.
     Install in the <head> of every page you want attributed. -->
<script type="text/javascript">
(function(s,p,o,t,i,f,y){s['SpotifyPixelObject']=i;s[i]=s[i]||function(){
(s[i].q=s[i].q||[]).push(arguments)},s[i].l=1*new Date();f=p.createElement(o),
y=p.getElementsByTagName(o)[0];f.async=1;f.src=t;y.parentNode.insertBefore(f,y)
})(window,document,'script','https://pixel.spotify.com/v1/pixel.js','spotify');

spotify('init', 'PIXEL_ID'); // ← replace with your Ad Studio Pixel ID
spotify('track', 'PageView');
</script>
<!-- End Spotify Pixel base code -->

<!-- Fire conversion events on the action/confirmation page, not on load: -->
<script type="text/javascript">
spotify('track', 'Purchase', { value: 99.99, currency: 'USD', order_id: 'ORDER_12345' });
</script>
<script type="text/javascript">
spotify('track', 'Lead', { lead_type: 'contact_form', value: 50.00 });
</script>
<script type="text/javascript">
spotify('track', 'SignUp', { signup_method: 'email' });
</script>`;

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
