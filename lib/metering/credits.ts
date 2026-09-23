// Marketr — hosted metering credit table (Phase C, W4).
//
// Spec Appendix A, v1. Unit: 1 credit = $0.01. Integer credits only —
// never floats. Cost-plus actions are priced at ~4x raw vendor cost;
// AI content actions are value-priced; publish and connector syncs cost 0
// (never punish the outcome).
//
// The table is versioned (CREDIT_TABLE_VERSION). Bumping the version with
// changed costs does NOT rewrite history: UsageEvent rows record the
// credits actually charged, and the table version at charge time is the
// source of truth for that row.

/** Credit table version. Bump when costs change; history is immutable. */
export const CREDIT_TABLE_VERSION = 1;

/** 1 credit = $0.01. */
export const CREDITS_PER_DOLLAR = 100;

export interface CreditCostDef {
  /** Integer credits charged per unit of the action. */
  credits: number;
  /** cost-plus | value | passthrough | free */
  basis: "cost-plus" | "value" | "passthrough" | "free";
  description: string;
}

export const CREDIT_COSTS = {
  // ── SEO data actions (cost-plus, ~4x raw DataForSEO cost) ──
  /** 1 keyword, live SERP. */
  rank_check: { credits: 1, basis: "cost-plus", description: "Rank check: 1 keyword, live SERP" },
  /** 1 live SERP pull. */
  serp_analysis: { credits: 1, basis: "cost-plus", description: "SERP analysis: 1 live SERP pull" },
  /** Search volumes, up to 100 keywords (1 task). */
  keyword_research: { credits: 40, basis: "cost-plus", description: "Keyword research run: volumes for up to 100 keywords" },
  /** Labs keyword ideas, ~1k items. */
  keyword_ideas: { credits: 50, basis: "cost-plus", description: "Keyword ideas expansion: ~1k items" },
  /** Labs ranked keywords, ~1k items. */
  keyword_gap: { credits: 50, basis: "cost-plus", description: "Competitor keyword gap: ~1k items" },
  /** On-Page crawl, up to 500 pages. */
  site_audit: { credits: 30, basis: "cost-plus", description: "Site audit: on-page crawl up to 500 pages" },
  /** 1 backlink summary request. */
  backlink_summary: { credits: 10, basis: "cost-plus", description: "Backlink summary check: 1 summary request" },

  // ── AI content actions (value-priced) ──
  /** AI brief generation. */
  content_brief: { credits: 5, basis: "value", description: "Content brief (AI)" },
  /** Full AI article. */
  ai_article: { credits: 15, basis: "value", description: "AI article generation" },
  /** AI decay refresh pass. */
  content_refresh: { credits: 10, basis: "value", description: "Content refresh (AI)" },

  // ── Orchestration (value-priced) ──
  /** Base fee per scheduled skill run, plus metered actions inside the run. */
  skill_run_base: { credits: 5, basis: "value", description: "Scheduled skill run: base fee" },
  /** Orchestration fee per spawned subagent, plus that subagent's actions. */
  subagent_spawn: { credits: 2, basis: "value", description: "Subagent spawn: orchestration fee" },

  // ── Passthrough / free ──
  /** MCP tool calls are metered at the underlying action's credits. */
  mcp_tool_call: { credits: 0, basis: "passthrough", description: "MCP tool call: underlying action's credits" },
  /** Publishing is never charged. */
  publish: { credits: 0, basis: "free", description: "Publish (free — never punish the outcome)" },
  /** Connector syncs are never charged. */
  connector_sync: { credits: 0, basis: "free", description: "Connector sync (free)" },
  /** Per GB-month beyond the included storage quota. */
  storage_over_quota: { credits: 1, basis: "value", description: "Storage over quota: per GB-month" },
} as const satisfies Record<string, CreditCostDef>;

/** Action keys meter() accepts. */
export type MeteredAction = keyof typeof CREDIT_COSTS;

/** True for actions known to the v1 table. */
export function isMeteredAction(action: string): action is MeteredAction {
  return action in CREDIT_COSTS;
}

/** Credits for one unit of the action. Throws on unknown actions. */
export function creditsFor(action: string): number {
  if (!isMeteredAction(action)) throw new Error(`unknown metered action: ${action}`);
  return CREDIT_COSTS[action].credits;
}

// ── Tier pools (spec Appendix A) ─────────────────────────────────────────────
// Seat tiers keep their base fee; each includes a monthly credit pool.
// Purchased top-up credits roll over 12 months (tracked via
// CreditBalance.purchasedExpiresAt).

export const TIER_INCLUDED_CREDITS = {
  self_hosted: 0, // self-host = BYO keys; metering records locally, no pool billed
  starter: 2500, // $29/mo
  pro: 10000, // $79/mo
  agency: 30000, // $199/mo
} as const;

export type TierKey = keyof typeof TIER_INCLUDED_CREDITS;

/** Included monthly pool for a workspace plan. Unknown plans → 0 (fail closed). */
export function includedCreditsForPlan(plan: string): number {
  return (TIER_INCLUDED_CREDITS as Record<string, number>)[plan] ?? 0;
}

/** Top-up packs (spec Appendix A). $50 = 5,000; $200 = 22,000 (10% bonus). */
export const TOPUP_PACKS = [
  { priceCents: 5000, credits: 5000 },
  { priceCents: 20000, credits: 22000 },
] as const;

/** Auto-overage per-credit price — opt-in only. Default is the hard cap. */
export const OVERAGE_CREDITS_PER_CENT = 1 / 1.2; // $0.012/credit
