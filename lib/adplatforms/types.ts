// Marketr — Phase 18 slice 1: ad-platforms type registry.
//
// The bounded surface humans AND agents use. Seven governed actions, one
// proposal → approval → execute pipeline. Money never moves without a
// SpendApproval; the gate (./gate.ts) enforces that fail-closed.
//
// Standing constraints (spec §0): zero custody of client spend, autopilot
// never buys media.

export const ADS_PLATFORM_KEYS = [
  "amazon",
  "stackadapt",
  "walmart",
  "spotify",
] as const;

export type AdsPlatformKey = (typeof ADS_PLATFORM_KEYS)[number];

export type AdsPlatformAuthKind = "oauth" | "api_key" | "guided";

export interface AdsPlatformDef {
  key: AdsPlatformKey;
  displayName: string;
  authKind: AdsPlatformAuthKind;
  /** Platform exposes a campaign-launch API we can call. */
  supportsApiLaunch: boolean;
  /** Platform exposes a reporting API we can pull. */
  supportsReportingApi: boolean;
  /** No public campaign API — guided setup only, spend tracked via UTM/pixel. */
  guidedOnly: boolean;
  /** OAuth connector key in lib/vault/oauth.ts (absent for guided-only). */
  oauthConnectorKey?: string;
}

/** Capability flags mirror the AdPlatform Prisma model. */
export const ADS_PLATFORMS: Record<AdsPlatformKey, AdsPlatformDef> = {
  amazon: {
    key: "amazon",
    displayName: "Amazon Ads",
    authKind: "oauth",
    supportsApiLaunch: true,
    supportsReportingApi: true,
    guidedOnly: false,
    oauthConnectorKey: "amazon-ads",
  },
  stackadapt: {
    key: "stackadapt",
    displayName: "StackAdapt",
    // GraphQL API uses a static API key (Authorization: Bearer), separate
    // from the REST key; the MCP surface is OAuth 2.1. Campaign management
    // goes through the key-based GraphQL API.
    authKind: "api_key",
    supportsApiLaunch: true,
    supportsReportingApi: true,
    guidedOnly: false,
  },
  walmart: {
    key: "walmart",
    displayName: "Walmart Connect",
    // Developer/partner program auth (consumer credentials + signed token).
    // The exact partner-program authorize URL is pinned in slice 4 when the
    // connector is built; slice 1 fails closed with "not configured".
    authKind: "oauth",
    supportsApiLaunch: true,
    supportsReportingApi: true,
    guidedOnly: false,
    oauthConnectorKey: "walmart-connect",
  },
  spotify: {
    key: "spotify",
    displayName: "Spotify",
    authKind: "guided",
    supportsApiLaunch: false,
    supportsReportingApi: false,
    guidedOnly: true,
  },
};

// ---------------------------------------------------------------------------
// Governed actions
// ---------------------------------------------------------------------------

export type AdsActionKind = "read" | "connect" | "propose" | "approve" | "execute";

export interface AdsGovernedAction {
  slug: string;
  label: string;
  kind: AdsActionKind;
  /** True when the action can move advertiser money (requires SpendApproval). */
  spendAction: boolean;
  description: string;
}

export const ADS_GOVERNED_ACTIONS: AdsGovernedAction[] = [
  {
    slug: "connect_account",
    label: "Connect ad account",
    kind: "connect",
    spendAction: false,
    description: "Start the OAuth/API-key flow linking a platform ad account. Tokens land in the Latchkey vault; only an opaque tokenRef is stored.",
  },
  {
    slug: "propose_campaign",
    label: "Propose campaign",
    kind: "propose",
    spendAction: false,
    description: "Draft a SpendProposal (launch, pause, budget change, or new flight). Creates no platform object and spends nothing.",
  },
  {
    slug: "approve_spend",
    label: "Approve spend",
    kind: "approve",
    spendAction: false,
    description: "Human approves a pending SpendProposal, minting the immutable SpendApproval bound to the proposal's scope hash.",
  },
  {
    slug: "launch",
    label: "Launch campaign",
    kind: "execute",
    spendAction: true,
    description: "Execute an approved launch proposal against the platform API. Impossible without a matching SpendApproval.",
  },
  {
    slug: "pause",
    label: "Pause campaign",
    kind: "execute",
    spendAction: true,
    description: "Execute an approved pause proposal against the platform API. Impossible without a matching SpendApproval.",
  },
  {
    slug: "adjust_budget",
    label: "Adjust budget",
    kind: "execute",
    spendAction: true,
    description: "Budget changes ALWAYS create a new SpendProposal first; execution requires its own SpendApproval. No in-place budget edits.",
  },
  {
    slug: "pull_report",
    label: "Pull report",
    kind: "read",
    spendAction: false,
    description: "Read normalized AdReport rows. Never gated — reads run freely.",
  },
];

export function adsActionDef(slug: string): AdsGovernedAction {
  const def = ADS_GOVERNED_ACTIONS.find((a) => a.slug === slug);
  if (!def) throw new Error(`Unknown ads governed action: ${slug}`);
  return def;
}

export function isAdsPlatformKey(value: string): value is AdsPlatformKey {
  return (ADS_PLATFORM_KEYS as readonly string[]).includes(value);
}
