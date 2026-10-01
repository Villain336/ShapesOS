// Marketr — Phase 18 slice 5: Spotify guided planning primitives (PURE).
//
// This module is intentionally prisma-free so client components can import
// it. guided.ts (DB-backed linking/registration/import) re-exports
// everything here.

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
