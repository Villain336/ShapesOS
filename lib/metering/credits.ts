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
export const CREDIT_TABLE_VERSION = 2;

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
  // ── Integration #7: Cloudinary upload pipeline (added 2026-09-27) ──
  // BEGIN: integration-7 cloudinary_upload (passthrough, zero credit)
  /** Signed Cloudinary upload minted. The user's own Cloudinary account is
   * billed by Cloudinary (free tier 25 credits/month) — Marketr never
   * charges ledger credits for it and never blocks on it. The zero-credit
   * event exists so each tenant's upload count is visible in the usage
   * ledger for quota awareness. */
  cloudinary_upload: { credits: 0, basis: "passthrough", description: "Cloudinary upload: user's own account (quota awareness)" },
  // END: integration-7 cloudinary_upload
  /** Per GB-month beyond the included storage quota. */
  storage_over_quota: { credits: 1, basis: "value", description: "Storage over quota: per GB-month" },

  // ── R6 prospecting & enrichment (added 2026-09-24) ──
  /** 1 enrichment provider lookup attempt in the waterfall (cost-plus ~4x of a ~$0.005 blended vendor cost). */
  enrichment_lookup: { credits: 2, basis: "cost-plus", description: "Enrichment lookup: 1 provider attempt" },
  /** AI research pass per prospect: summary + icebreakers + first lines (value-priced). */
  prospect_research: { credits: 5, basis: "value", description: "Prospect AI research: summary + icebreakers + first lines" },

  // ── R3 messaging (added 2026-09-24; 1 credit = $0.01) ──
  /** One outbound SMS segment (R3 messaging core). Raw vendor ~1¢ → 4cr. */
  sms_send: { credits: 4, basis: "cost-plus", description: "Outbound SMS: 1 segment (R3 messaging)" },
  /** One outbound email (R3 messaging core). Raw vendor ~0.1¢ → 1cr floor. */
  email_send: { credits: 1, basis: "cost-plus", description: "Outbound email: 1 message (R3 messaging)" },

  // ── R3 direct mail (added 2026-09-24, Phase 4 R3-integration) ──
  /** One addressed mail piece sent (postcard|letter). Default ≈ cost-plus
   * 2.5× on a 4×6 postcard baseline; the dispatcher overrides with the live
   * provider estimate × margin at send time. */
  mail_piece: { credits: 250, basis: "cost-plus", description: "Direct mail: 1 addressed piece sent (R3 mail channel)" },
  /** One address verification (CASS) lookup ahead of a mail piece. */
  mail_verification: { credits: 5, basis: "cost-plus", description: "Address verification: 1 CASS lookup (R3 mail channel)" },

  /* PROVIDER:brandfetch */
  /** Brandfetch brand lookup: 0 credits — vendor-billed on the user's own
   * BYO key; the ledger event exists for per-tenant usage visibility only.
   * Follows the publish/connector_sync free-action precedent. */
  brandfetch_lookup: { credits: 0, basis: "free", description: "Brandfetch brand lookup (BYO key, vendor-billed)" },
  /* END */
  /* INTEGRATION:activepieces */
  /** Activepieces flow trigger: 0 credits — the automation engine is the
   * user's own self-hosted sidecar (BYO, vendor-billed by nobody); the ledger
   * event exists for per-tenant usage visibility only. Follows the
   * brandfetch_lookup free-action precedent. */
  automation_flow_trigger: { credits: 0, basis: "free", description: "Activepieces flow trigger (BYO engine)" },
  /** Activepieces run status read: 0 credits — local ledger read of the
   * engine's run list on the user's own sidecar. */
  automation_flow_status: { credits: 0, basis: "free", description: "Activepieces flow run status read (BYO engine)" },
  /* END */
  // ── Phase 14 slice 10: Composio tool-call metering ──
  /** One executed Composio hosted tool call. cost-plus (~4x) on an estimated
   * ~$0.0025/action hosted execution cost (Composio free tier: 20,000
   * actions/month on the platform key; see lib/integrations/actions/budget.ts).
   * 1 credit = $0.01. */
  composio_tool_call: { credits: 1, basis: "cost-plus", description: "Composio action: 1 hosted tool call" },
  // ── Phase 7: LLM token usage (chat()/chatStream(), lib/llm/usage.ts) ──
  /** One model call: token counts, model and estimated vendor cost are on
   * the event row (usage_events.llm_*). Zero credits for now — it makes
   * token spend visible per workspace and per agent run; charging credits
   * for it (and a per-run cost cap) is a pricing decision for Phase 8, and
   * value-priced actions (ai_article …) already include their model cost. */
  llm_tokens: { credits: 0, basis: "passthrough", description: "LLM tokens: one model call (tokens + estimated cost recorded)" },
  // ── Phase 7: OpenAI image generation (lib/images) ──
  /** One generated or edited image, medium quality, 1024x1024. cost-plus
   * (~4x) on OpenAI's own GPT Image 2 table (image-generation guide,
   * "Calculating costs", checked 2026-10-04): $0.053 → 22 credits. Low and
   * high quality, larger sizes and Batch (50% off) are priced by
   * imageGenerationCredits() and passed as meter()'s `credits` override. */
  image_generation: { credits: 22, basis: "cost-plus", description: "AI image: 1 image (OpenAI image model)" },
  // ── MCP free reads (lib/mcp/scopes.ts TOOL_CREDIT_PASSTHROUGH) ──
  // These passthrough actions were never in the table, so the metering
  // service refused them as unknown and the MCP tools failed closed
  // ("Metering is temporarily unavailable") for every caller. Free — reads
  // of the workspace's own data; the usage row is the audit trail.
  project_list: { credits: 0, basis: "free", description: "MCP: list projects" },
  skill_list: { credits: 0, basis: "free", description: "MCP: list scheduled skills" },
  usage_summary: { credits: 0, basis: "free", description: "MCP: usage summary" },
  dataset_ask: { credits: 0, basis: "free", description: "MCP: ask the business-data dataset" },
  dataset_adapter_pull: { credits: 0, basis: "free", description: "MCP: dataset adapter pull" },
} as const satisfies Record<string, CreditCostDef>;

/** Credits per 1024x1024 image by quality: ~4x OpenAI's GPT Image 2 price
 *  ($0.006 / $0.053 / $0.211), rounded up. */
export const IMAGE_CREDITS_BY_QUALITY = { low: 3, medium: 22, high: 85 } as const;

/**
 * Credits for `n` images. The three standard sizes and "auto" are priced at
 * 1024x1024 (the dearest of the three in OpenAI's table); a custom
 * WIDTHxHEIGHT above 1024x1024 scales by pixel count (an estimate — OpenAI
 * bills output tokens, which grow with size). Batch jobs are half price, as
 * OpenAI's Batch API is. Never below 1 per image.
 */
export function imageGenerationCredits(args: {
  quality: keyof typeof IMAGE_CREDITS_BY_QUALITY;
  size?: string | null;
  n?: number;
  batch?: boolean;
}): number {
  const per = IMAGE_CREDITS_BY_QUALITY[args.quality];
  let scale = 1;
  const m = /^(\d+)x(\d+)$/.exec((args.size ?? "").trim());
  const standard = ["1024x1024", "1536x1024", "1024x1536"].includes((args.size ?? "").trim());
  if (m && !standard) scale = Math.max(1, (Number(m[1]) * Number(m[2])) / (1024 * 1024));
  const n = Math.max(1, Math.floor(args.n ?? 1));
  const total = Math.ceil(per * scale * (args.batch ? 0.5 : 1)) * n;
  return Math.max(n, total);
}

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

// ── Tier pools (Phase 15.3 pricing: base fee + seats + credits) ─────────────
// Each paid tier includes a monthly credit pool (pre-paid usage at 1 credit =
// $0.01). Purchased top-up credits roll over 12 months (tracked via
// CreditBalance.purchasedExpiresAt). Prices and seats live in
// lib/billing/plans.ts and lib/billing/entitlements.ts.
//
// OWNER KNOB — the included credits are provisional: the Phase 17 evaluation
// (cache layout + model routing) is expected to make each AI turn ~5× cheaper,
// and the plan is to DOUBLE every paid pool once that is confirmed
// (Starter 8,000 · Pro 30,000 · Business 80,000 · Agency 60,000). That is a
// one-line change: set INCLUDED_CREDITS_MULTIPLIER to 2. Each base number
// below can also be edited on its own.
export const INCLUDED_CREDITS_MULTIPLIER = 1;

/** Monthly included pool per paid plan, before INCLUDED_CREDITS_MULTIPLIER. */
export const BASE_INCLUDED_CREDITS = {
  starter: 4_000, // $59/mo
  pro: 15_000, // $199/mo
  business: 40_000, // $499/mo
  agency: 30_000, // $399/mo — pooled across the agency's client workspaces (see plans.ts)
} as const;

/**
 * Phase 3 hosted trial (lib/billing/trial.ts): a ONE-TIME pool for the
 * 14-day trial — it does not refill at a month boundary — behind the hard
 * cap; no auto-overage. Not scaled by the multiplier (a trial is a taste).
 */
export const TRIAL_INCLUDED_CREDITS = 1_000;

export const TIER_INCLUDED_CREDITS = {
  // Self-host = bring your own keys; metering records locally, no pool
  // billed. A hosted workspace that brings its own model key (Phase 15.1,
  // keySource "workspace") also spends 0 credits on those calls on ANY plan.
  self_hosted: 0,
  trial: TRIAL_INCLUDED_CREDITS,
  starter: BASE_INCLUDED_CREDITS.starter * INCLUDED_CREDITS_MULTIPLIER,
  pro: BASE_INCLUDED_CREDITS.pro * INCLUDED_CREDITS_MULTIPLIER,
  business: BASE_INCLUDED_CREDITS.business * INCLUDED_CREDITS_MULTIPLIER,
  agency: BASE_INCLUDED_CREDITS.agency * INCLUDED_CREDITS_MULTIPLIER,
} as const satisfies Record<string, number>;

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
