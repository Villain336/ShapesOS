// Marketr — curated Activepieces piece catalog (Phase 12, Worker 3).
//
// Server-only. The MIT-community piece packages are consumed as npm/TS
// packages (NOT vendored, NOT forked — `packages/ee/` is commercial and is
// never touched). Piece metadata (display names, triggers, actions) is read
// live from the installed packages' `Piece.metadata()` so the catalog can't
// drift from the engine's vocabulary.
//
// Curated set: the marketing-valuable pieces only (webhooks, HTTP, email,
// sheets, social, slack, AI) — "don't boil the ocean".

import type { CuratedPiece, AutomationRecipe } from "./types";

type PieceModule = Record<string, unknown>;

/** One curated piece: which npm package + which export to read. */
interface CuratedSpec {
  packageName: string;
  /**
   * Static loader. Must be a string-literal dynamic import per package: a computed
   * import of `spec.packageName` compiles but throws "Cannot find module as
   * expression is too dynamic" in the production (Turbopack) build. The
   * packages are also listed in next.config.ts serverExternalPackages so
   * Node resolves them at runtime instead of Turbopack bundling them.
   */
  load: () => Promise<PieceModule>;
  /** Key inside the package's default export (auth/connection helpers skipped). */
  exportKey: string;
  /** Why this piece matters for marketing automation. */
  marketingUse: string;
}

const CURATED: CuratedSpec[] = [
  {
    packageName: "@activepieces/piece-webhook",
    load: () => import("@activepieces/piece-webhook"),
    exportKey: "webhook",
    marketingUse: "Entry point: let Marketr missions, playbooks, or external apps fire a flow with a JSON payload.",
  },
  {
    packageName: "@activepieces/piece-schedule",
    load: () => import("@activepieces/piece-schedule"),
    exportKey: "schedule",
    marketingUse: "Cron-style triggers: weekly rank digests, review-velocity drives, content cadences.",
  },
  {
    packageName: "@activepieces/piece-http",
    load: () => import("@activepieces/piece-http"),
    exportKey: "http",
    marketingUse: "Call any Marketr API route or third-party endpoint from inside a flow.",
  },
  {
    packageName: "@activepieces/piece-smtp",
    load: () => import("@activepieces/piece-smtp"),
    exportKey: "smtp",
    marketingUse: "Send transactional and marketing email from your own SMTP — no vendor lock-in.",
  },
  {
    packageName: "@activepieces/piece-google-sheets",
    load: () => import("@activepieces/piece-google-sheets"),
    exportKey: "googleSheets",
    marketingUse: "Append leads, rankings, and spend rows to sheets the agency already owns.",
  },
  {
    packageName: "@activepieces/piece-mailchimp",
    load: () => import("@activepieces/piece-mailchimp"),
    exportKey: "mailchimp",
    marketingUse: "Email campaigns, audience sync, and subscriber tagging for nurture programs.",
  },
  {
    packageName: "@activepieces/piece-twitter",
    load: () => import("@activepieces/piece-twitter"),
    exportKey: "twitter",
    marketingUse: "Post tweets and replies for the social publishing layer.",
  },
  {
    packageName: "@activepieces/piece-facebook-pages",
    load: () => import("@activepieces/piece-facebook-pages"),
    exportKey: "facebookPages",
    marketingUse: "Post to managed Facebook Pages (text, photo, video).",
  },
  {
    packageName: "@activepieces/piece-instagram-business",
    load: () => import("@activepieces/piece-instagram-business"),
    exportKey: "instagramBusiness",
    marketingUse: "Publish photos, reels, carousels, and stories to Instagram Business accounts.",
  },
  {
    packageName: "@activepieces/piece-linkedin",
    load: () => import("@activepieces/piece-linkedin"),
    exportKey: "linkedin",
    marketingUse: "Post personal and company updates for B2B distribution.",
  },
  {
    packageName: "@activepieces/piece-slack",
    load: () => import("@activepieces/piece-slack"),
    exportKey: "slack",
    marketingUse: "Alert the team in Slack; approve-or-deny flows via message actions.",
  },
  {
    packageName: "@activepieces/piece-openai",
    load: () => import("@activepieces/piece-openai"),
    exportKey: "openai",
    marketingUse: "Summarize, classify, and draft inside flows (run summaries, review triage).",
  },
  {
    packageName: "@activepieces/piece-rss",
    load: () => import("@activepieces/piece-rss"),
    exportKey: "rssFeed",
    marketingUse: "Trigger on new feed items — competitor blogs, industry news for the Wire.",
  },
];

interface PieceMetadataLike {
  displayName?: string;
  description?: string;
  triggers?: Record<string, unknown>;
  actions?: Record<string, unknown>;
}

async function readPieceMeta(spec: CuratedSpec): Promise<CuratedPiece> {
  // Lazy import keeps the catalog cheap — routes/tests only pay for it
  // when they ask for the catalog.
  const mod = await spec.load();
  // Dual-build packages expose the piece either as a named export or under
  // `default` — accept both shapes (they differ between CJS/ESM builds).
  const named = mod[spec.exportKey];
  const underDefault =
    mod.default && typeof mod.default === "object"
      ? (mod.default as Record<string, unknown>)[spec.exportKey]
      : undefined;
  const piece = (named ?? underDefault) as
    | { metadata?: () => PieceMetadataLike; displayName?: string; description?: string }
    | undefined;
  let meta: PieceMetadataLike = {};
  try {
    meta = piece?.metadata?.() ?? {};
  } catch {
    meta = {};
  }
  // Prefer the piece instance's own displayName (prettier) over metadata's.
  const displayName = piece?.displayName ?? meta.displayName ?? spec.exportKey;
  const description = piece?.description ?? meta.description ?? null;
  // Version comes from the installed package (npm metadata).
  const version = installedVersion(spec.packageName);
  return {
    packageName: spec.packageName,
    name: spec.packageName,
    displayName,
    version,
    description,
    triggers: Object.keys(meta.triggers ?? {}),
    actions: Object.keys(meta.actions ?? {}),
    marketingUse: spec.marketingUse,
    // Deliberately null: Activepieces docs URLs are versioned; guessing one
    // would be a fabricated link. The piece name is enough to find it.
    docsUrl: null,
  };
}

/**
 * Installed version from the package's own package.json. Resolved with a
 * runtime require built via process.getBuiltinModule, which the bundler does
 * not rewrite (a bundled computed require of "<name>/package.json" is "too
 * dynamic" in production). Never throws — "unknown" when it can't be read.
 */
function installedVersion(packageName: string): string {
  try {
    const nodeModule = process.getBuiltinModule?.("node:module");
    if (!nodeModule) return "unknown";
    const req = nodeModule.createRequire(`${process.cwd()}/package.json`);
    const pkg = req(`${packageName}/package.json`) as { version?: unknown };
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

let cached: Promise<CuratedPiece[]> | null = null;

/** The curated marketing piece catalog, read live from installed packages. */
export function curatedPieces(): Promise<CuratedPiece[]> {
  if (!cached) {
    cached = Promise.all(CURATED.map(readPieceMeta));
    // A failed load must not poison the cache for the life of the process.
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

/** Find one curated piece by npm package name. */
export async function curatedPiece(packageName: string): Promise<CuratedPiece | null> {
  const all = await curatedPieces();
  return all.find((p) => p.packageName === packageName) ?? null;
}

/**
 * Marketing automation recipes — piece combinations the Chief Strategy
 * Agent can propose in missions/playbooks. Recipes are documentation, not
 * code: the actual flow is authored in the Activepieces builder.
 */
export const AUTOMATION_RECIPES: AutomationRecipe[] = [
  {
    id: "lead-capture-fanout",
    title: "New lead → Sheets + Slack",
    description: "Marketr (or a landing page) POSTs a lead payload to a webhook flow; the flow appends it to Google Sheets and pings #sales in Slack.",
    pieces: ["@activepieces/piece-webhook", "@activepieces/piece-google-sheets", "@activepieces/piece-slack"],
    triggerPiece: "@activepieces/piece-webhook",
  },
  {
    id: "review-velocity-drive",
    title: "Weekly review-request drive",
    description: "Scheduled flow pulls recent customers from Sheets, sends review-request emails via SMTP, and logs sends back to the sheet.",
    pieces: ["@activepieces/piece-schedule", "@activepieces/piece-google-sheets", "@activepieces/piece-smtp"],
    triggerPiece: "@activepieces/piece-schedule",
  },
  {
    id: "weekly-rank-digest",
    title: "Weekly rank digest",
    description: "Schedule trigger → HTTP call into Marketr's rank API → OpenAI summarizes movers → Mailchimp campaign to the client.",
    pieces: ["@activepieces/piece-schedule", "@activepieces/piece-http", "@activepieces/piece-openai", "@activepieces/piece-mailchimp"],
    triggerPiece: "@activepieces/piece-schedule",
  },
  {
    id: "social-crosspost",
    title: "One post → X + Facebook + Instagram + LinkedIn",
    description: "A webhook flow receives {text, imageUrl} from a mission step and publishes to every social channel with per-channel variants.",
    pieces: [
      "@activepieces/piece-webhook",
      "@activepieces/piece-twitter",
      "@activepieces/piece-facebook-pages",
      "@activepieces/piece-instagram-business",
      "@activepieces/piece-linkedin",
    ],
    triggerPiece: "@activepieces/piece-webhook",
  },
  {
    id: "competitor-watch",
    title: "Competitor blog watch",
    description: "RSS trigger watches competitor feeds; new posts get summarized by OpenAI and dropped into Slack for the strategist.",
    pieces: ["@activepieces/piece-rss", "@activepieces/piece-openai", "@activepieces/piece-slack"],
    triggerPiece: "@activepieces/piece-rss",
  },
];

export function getRecipe(id: string): AutomationRecipe | null {
  return AUTOMATION_RECIPES.find((r) => r.id === id) ?? null;
}
