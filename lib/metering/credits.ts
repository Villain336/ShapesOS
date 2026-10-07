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

/** Credit table version. Bump when costs change; history is immutable.
 *  v3 (Phase 15.2): llm_tokens is cost-based (1.5× provider cost), new
 *  metered actions for sandbox minutes, Twilio voice, intelligence vendors,
 *  GEO prompt runs and Penpot imports; every action has a category. */
export const CREDIT_TABLE_VERSION = 3;

/** 1 credit = $0.01. */
export const CREDITS_PER_DOLLAR = 100;

/** Phase 15.2: the Usage page groups credits by what they bought. */
// Phase 19A (WS=server): + "cursor" (the agentic cursor's talk minutes and spoken answers).
export type CreditCategory = "ai" | "data" | "messaging" | "compute" | "other" | "cursor";

export const CREDIT_CATEGORIES: readonly CreditCategory[] = ["ai", "data", "messaging", "compute", "other", "cursor"];

export interface CreditCostDef {
  /** Integer credits charged per unit of the action. */
  credits: number;
  /** cost-plus | value | passthrough | free */
  basis: "cost-plus" | "value" | "passthrough" | "free";
  description: string;
  /**
   * Phase 15.2: Usage-page category. Optional in the type so an action added
   * elsewhere still compiles, but the unit suite fails until it has one
   * (categoryOf() reads "other" meanwhile).
   */
  category?: CreditCategory;
}

// ── Phase 15.4 (zernio): connected Zernio accounts + managed ads ──────────
// OWNER KNOBS. Zernio bills ShapesOS per connected account per month (2 free,
// accounts 3–10 at $6, 11–100 at $3, 101+ at $1; ads included, managed ads
// 500 free per account per month then a per-active-ad charge).
/** Credits per connected Zernio account per month: ~2× Zernio's marginal $3 rate (1 credit = $0.01). */
export const ZERNIO_ACCOUNT_MONTH_CREDITS = 600;
/** Every workspace's first connected accounts are included, whatever the plan (plans may include more: lib/billing/entitlements.ts ZERNIO_INCLUDED_ACCOUNTS). */
export const ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE = 2;
/** Managed-ad overage Zernio bills for a workspace's profile is passed through at cost × this margin. */
export const ZERNIO_MANAGED_ADS_MARGIN = 1.25;

export const CREDIT_COSTS = {
  // ── SEO data actions (cost-plus, ~4x raw DataForSEO cost) ──
  /** 1 keyword, live SERP. */
  rank_check: { credits: 1, basis: "cost-plus", description: "Rank check: 1 keyword, live SERP", category: "data" },
  /** 1 live SERP pull. */
  serp_analysis: { credits: 1, basis: "cost-plus", description: "SERP analysis: 1 live SERP pull", category: "data" },
  /** Search volumes, up to 100 keywords (1 task). */
  keyword_research: { credits: 40, basis: "cost-plus", description: "Keyword research run: volumes for up to 100 keywords", category: "data" },
  /** Labs keyword ideas, ~1k items. */
  keyword_ideas: { credits: 50, basis: "cost-plus", description: "Keyword ideas expansion: ~1k items", category: "data" },
  /** Labs ranked keywords, ~1k items. */
  keyword_gap: { credits: 50, basis: "cost-plus", description: "Competitor keyword gap: ~1k items", category: "data" },
  /** On-Page crawl, up to 500 pages. */
  site_audit: { credits: 30, basis: "cost-plus", description: "Site audit: on-page crawl up to 500 pages", category: "data" },
  /** 1 backlink summary request. */
  backlink_summary: { credits: 10, basis: "cost-plus", description: "Backlink summary check: 1 summary request", category: "data" },

  // ── AI content actions (value-priced) ──
  /** AI brief generation. */
  content_brief: { credits: 5, basis: "value", description: "Content brief (AI)", category: "ai" },
  /** Full AI article. */
  ai_article: { credits: 15, basis: "value", description: "AI article generation", category: "ai" },
  /** AI decay refresh pass. */
  content_refresh: { credits: 10, basis: "value", description: "Content refresh (AI)", category: "ai" },

  // ── Orchestration (value-priced) ──
  /** Base fee per scheduled skill run, plus metered actions inside the run. */
  skill_run_base: { credits: 5, basis: "value", description: "Scheduled skill run: base fee", category: "ai" },
  /** Orchestration fee per spawned subagent, plus that subagent's actions. */
  subagent_spawn: { credits: 2, basis: "value", description: "Subagent spawn: orchestration fee", category: "ai" },

  // ── Passthrough / free ──
  /** MCP tool calls are metered at the underlying action's credits. */
  mcp_tool_call: { credits: 0, basis: "passthrough", description: "MCP tool call: underlying action's credits", category: "other" },
  /** Publishing is never charged. */
  publish: { credits: 0, basis: "free", description: "Publish (free — never punish the outcome)", category: "other" },
  /** Connector syncs are never charged. */
  connector_sync: { credits: 0, basis: "free", description: "Connector sync (free)", category: "other" },
  // ── Integration #7: Cloudinary upload pipeline (added 2026-09-27) ──
  // BEGIN: integration-7 cloudinary_upload (passthrough, zero credit)
  /** Signed Cloudinary upload minted. The user's own Cloudinary account is
   * billed by Cloudinary (free tier 25 credits/month) — Marketr never
   * charges ledger credits for it and never blocks on it. The zero-credit
   * event exists so each tenant's upload count is visible in the usage
   * ledger for quota awareness. */
  cloudinary_upload: { credits: 0, basis: "passthrough", description: "Cloudinary upload: user's own account (quota awareness)", category: "other" },
  // END: integration-7 cloudinary_upload
  /** Per GB-month beyond the included storage quota. */
  storage_over_quota: { credits: 1, basis: "value", description: "Storage over quota: per GB-month", category: "compute" },

  // ── R6 prospecting & enrichment (added 2026-09-24) ──
  /** 1 enrichment provider lookup attempt in the waterfall (cost-plus ~4x of a ~$0.005 blended vendor cost). */
  enrichment_lookup: { credits: 2, basis: "cost-plus", description: "Enrichment lookup: 1 provider attempt", category: "data" },
  /** AI research pass per prospect: summary + icebreakers + first lines (value-priced). */
  prospect_research: { credits: 5, basis: "value", description: "Prospect AI research: summary + icebreakers + first lines", category: "ai" },

  // ── R3 messaging (added 2026-09-24; 1 credit = $0.01) ──
  /** One outbound SMS segment (R3 messaging core). Raw vendor ~1¢ → 4cr. */
  sms_send: { credits: 4, basis: "cost-plus", description: "Outbound SMS: 1 segment (R3 messaging)", category: "messaging" },
  /** One outbound email (R3 messaging core). Raw vendor ~0.1¢ → 1cr floor. */
  email_send: { credits: 1, basis: "cost-plus", description: "Outbound email: 1 message (R3 messaging)", category: "messaging" },

  // ── R3 direct mail (added 2026-09-24, Phase 4 R3-integration) ──
  /** One addressed mail piece sent (postcard|letter). Default ≈ cost-plus
   * 2.5× on a 4×6 postcard baseline; the dispatcher overrides with the live
   * provider estimate × margin at send time. */
  mail_piece: { credits: 250, basis: "cost-plus", description: "Direct mail: 1 addressed piece sent (R3 mail channel)", category: "messaging" },
  /** One address verification (CASS) lookup ahead of a mail piece. */
  mail_verification: { credits: 5, basis: "cost-plus", description: "Address verification: 1 CASS lookup (R3 mail channel)", category: "messaging" },

  /* PROVIDER:brandfetch */
  /** Brandfetch brand lookup: 0 credits — vendor-billed on the user's own
   * BYO key; the ledger event exists for per-tenant usage visibility only.
   * Follows the publish/connector_sync free-action precedent. */
  brandfetch_lookup: { credits: 0, basis: "free", description: "Brandfetch brand lookup (BYO key, vendor-billed)", category: "data" },
  /* END */
  /* INTEGRATION:activepieces */
  /** Activepieces flow trigger: 0 credits — the automation engine is the
   * user's own self-hosted sidecar (BYO, vendor-billed by nobody); the ledger
   * event exists for per-tenant usage visibility only. Follows the
   * brandfetch_lookup free-action precedent. */
  automation_flow_trigger: { credits: 0, basis: "free", description: "Activepieces flow trigger (BYO engine)", category: "other" },
  /** Activepieces run status read: 0 credits — local ledger read of the
   * engine's run list on the user's own sidecar. */
  automation_flow_status: { credits: 0, basis: "free", description: "Activepieces flow run status read (BYO engine)", category: "other" },
  /* END */
  // ── Phase 14 slice 10: Composio tool-call metering ──
  /** One executed Composio hosted tool call. cost-plus (~4x) on an estimated
   * ~$0.0025/action hosted execution cost (Composio free tier: 20,000
   * actions/month on the platform key; see lib/integrations/actions/budget.ts).
   * 1 credit = $0.01. */
  composio_tool_call: { credits: 1, basis: "cost-plus", description: "Composio action: 1 hosted tool call", category: "other" },
  // ── Phase 7 / 15.2: LLM token usage (chat()/chatStream()/generate(), lib/llm/usage.ts) ──
  /** One model call, cost-based since Phase 15.2: credits =
   * ceil(provider cost USD × 100 × LLM_TOKEN_COST_MULTIPLIER) — 1.5× cost at
   * $0.01/credit (llmTokenCredits(), passed as meter()'s `credits`). A model
   * with no price is charged at the most expensive known rates, never 0. A
   * call on the workspace's OWN key (keySource "workspace") is 0 credits; a
   * call inside a value-priced action (ai_article …) is recorded at 0 —
   * that action's price already includes it. `credits` here is the floor a
   * priced call can cost (1). Token counts, model and cost are on the row. */
  llm_tokens: { credits: 1, basis: "cost-plus", description: "LLM tokens: one model call at 1.5× provider cost", category: "ai" },
  // ── Phase 7: OpenAI image generation (lib/images) ──
  /** One generated or edited image, medium quality, 1024x1024. cost-plus
   * (~4x) on OpenAI's own GPT Image 2 table (image-generation guide,
   * "Calculating costs", checked 2026-10-04): $0.053 → 22 credits. Low and
   * high quality, larger sizes and Batch (50% off) are priced by
   * imageGenerationCredits() and passed as meter()'s `credits` override. */
  image_generation: { credits: 22, basis: "cost-plus", description: "AI image: 1 image (OpenAI image model)", category: "ai" },
  // ── MCP free reads (lib/mcp/scopes.ts TOOL_CREDIT_PASSTHROUGH) ──
  // These passthrough actions were never in the table, so the metering
  // service refused them as unknown and the MCP tools failed closed
  // ("Metering is temporarily unavailable") for every caller. Free — reads
  // of the workspace's own data; the usage row is the audit trail.
  project_list: { credits: 0, basis: "free", description: "MCP: list projects", category: "other" },
  skill_list: { credits: 0, basis: "free", description: "MCP: list scheduled skills", category: "other" },
  usage_summary: { credits: 0, basis: "free", description: "MCP: usage summary", category: "other" },
  dataset_ask: { credits: 0, basis: "free", description: "MCP: ask the business-data dataset", category: "other" },
  dataset_adapter_pull: { credits: 0, basis: "free", description: "MCP: dataset adapter pull", category: "other" },
  // ── Phase 15.2: metered gaps (platform-paid calls that were unbilled) ──
  /** One started minute of a hosted code sandbox (E2B / Daytona; a local
   * Docker sandbox is the operator's own box and is not charged). E2B's
   * default 2 vCPU sandbox ≈ $0.0028/min (2 × $0.000014/vCPU-s + memory);
   * cost-plus ~4× → 1 credit. Charged when the sandbox ends
   * (lib/sandbox/metering.ts). */
  sandbox_minute: { credits: 1, basis: "cost-plus", description: "Code sandbox: 1 started minute (E2B / Daytona)", category: "compute" },
  /** One started minute of a tracked Twilio voice call. Twilio US local
   * voice ≈ $0.0085 in / $0.014 out per minute; cost-plus ~4× of the outbound
   * rate → 6 credits. */
  call_minute: { credits: 6, basis: "cost-plus", description: "Voice call: 1 started minute (Twilio)", category: "messaging" },
  /** One started minute of call transcription (Twilio <Record> transcribe,
   * $0.05/min; cost-plus ~4× → 20 credits). */
  call_transcription_minute: { credits: 20, basis: "cost-plus", description: "Call transcription: 1 started minute (Twilio)", category: "messaging" },
  /** Phase 18.2 (WS=content): one started minute of a browser voice note
   * transcribed by the Whisper-class API on the platform key ($0.006/min;
   * cost-plus ~4× → 3 credits). A new action, no existing price changed. */
  voice_note_minute: { credits: 3, basis: "cost-plus", description: "Voice note transcription: 1 started minute (Whisper)", category: "ai" },
  /** One tracking number for one month (Twilio US local number $1.15/mo;
   * cost-plus ~4× → 460 credits). Charged at purchase and on each monthly
   * metering run while the number is active. */
  phone_number_month: { credits: 460, basis: "cost-plus", description: "Tracking number: 1 month (Twilio)", category: "messaging" },
  /** One Phase 10 intelligence vendor call (SERP, volume, backlinks) on the
   * platform key: the api_meter USD × INTELLIGENCE_VENDOR_MULTIPLIER (4×),
   * rounded up (vendorUsdCredits(), passed as `credits`); 1 = the floor. A
   * workspace's own vendor key is 0 credits. */
  intelligence_vendor_call: { credits: 1, basis: "cost-plus", description: "Data vendor call: SERP / volume / backlinks at 4× cost", category: "data" },
  /** One GEO (AI visibility) prompt run or its judge call: the engine's
   * estimated USD × 4, rounded up (1 = the floor). */
  geo_prompt_run: { credits: 1, basis: "cost-plus", description: "AI visibility (GEO) prompt run at 4× cost", category: "data" },
  /** One Context.dev call on the PLATFORM key, per Context.dev credit it
   * costs (Context.dev pricing, checked 2026-10-05: Developer overage $2.20
   * per 1,000 credits = $0.0022; ~4× → 1 credit). A workspace's own
   * Context.dev key is free. Charged at the budget gate before the call. */
  contextdev_call: { credits: 1, basis: "cost-plus", description: "Context.dev (platform key): per Context.dev credit", category: "data" },
  /** Penpot design-token import. 0 credits: Penpot is the user's own
   * instance (BYO) — the event exists for per-tenant usage visibility only
   * (the import route has metered it since Phase 11; the action was missing
   * from the table, so every charge came back "unknown_action"). */
  penpot_import: { credits: 0, basis: "free", description: "Penpot token import (BYO instance)", category: "other" },
  // ── Phase 15.4 (zernio) — appended; the keys workstream appends its own ──
  /** One connected Zernio account beyond the included ones, for one month
   *  (lib/zernio/metering.ts; idempotent per workspace + month). */
  zernio_account_month: {
    credits: ZERNIO_ACCOUNT_MONTH_CREDITS,
    basis: "cost-plus",
    description: "Zernio: 1 connected account for a month, beyond the included accounts",
    category: "messaging",
  },
  /** Managed-ad overage Zernio billed for the workspace's profile, passed
   *  through at cost × ZERNIO_MANAGED_ADS_MARGIN (credits override). */
  zernio_managed_ads: {
    credits: 0,
    basis: "passthrough",
    description: "Zernio managed ads beyond the free allowance: Zernio's charge at cost plus margin",
    category: "messaging",
  },
  // ── Phase 19A (WS=server): the agentic cursor (ShapesOS Desktop) ──
  // Priced from provider cost at the Phase 15.2 cost-plus rule (~4× vendor
  // cost, rounded up; 1 credit = $0.01). Constants below; see
  // lib/cursor/metering.ts for the per-provider amounts actually charged.
  /** One started minute of hold-to-talk speech input, AFTER the plan's
   *  included talk minutes (lib/billing/entitlements.ts
   *  CURSOR_TALK_MINUTES_INCLUDED). Table price = the dearer provider:
   *  Deepgram Nova-3 streaming $0.0077/min (regular PAYG, checked
   *  2026-10-06) × 4 = $0.0308 → 4 credits. AssemblyAI Universal-Streaming
   *  is $0.15/h = $0.0025/min × 4 = $0.01 → 1 credit (CURSOR_TALK_MINUTE_CREDITS). */
  cursor_talk_minute: { credits: 4, basis: "cost-plus", description: "Cursor talk: 1 started minute of speech input, past the plan's included minutes", category: "cursor" },
  /** 1,000 characters of spoken answer (rounded up). Table price = ElevenLabs
   *  Flash/Turbo $0.04 per 1k chars (API pricing, checked 2026-10-06) × 4 =
   *  $0.16 → 16 credits. Multilingual models ($0.08) → 32, OpenAI tts-1
   *  ($0.015) → 6, self-hosted VoiceStudio → 0 (CURSOR_TTS_CREDITS_PER_1K). */
  cursor_tts_1k_chars: { credits: 16, basis: "cost-plus", description: "Cursor voice: 1,000 characters of spoken answer", category: "cursor" },
} as const satisfies Record<string, CreditCostDef>;

// ── Phase 15.2: cost-based conversions (named constants; owner knobs) ───────

/** Model tokens are charged at 1.5× the provider's list cost. */
export const LLM_TOKEN_COST_MULTIPLIER = 1.5;

/** Credits per Context.dev credit on the platform key (≈4× $0.0022). */
export const CONTEXTDEV_PLATFORM_CREDITS_PER_VENDOR_CREDIT = 1;

/** Phase 10 intelligence vendor calls are charged at 4× their USD cost. */
export const INTELLIGENCE_VENDOR_MULTIPLIER = 4;

/**
 * Credits for one model call: ceil(cost USD × 100 × LLM_TOKEN_COST_MULTIPLIER).
 * On micro-USD (1 USD = 1,000,000): ceil(micro × 100 × 1.5 / 1,000,000).
 * 0 cost → 0 credits; any positive cost → at least 1.
 */
export function llmTokenCredits(costMicroUsd: number): number {
  if (!Number.isFinite(costMicroUsd) || costMicroUsd <= 0) return 0;
  // Scale the multiplier to an integer (1.5 → 15 / 10) so the product stays
  // exact in integer arithmetic for any realistic call cost.
  const multTenths = Math.round(LLM_TOKEN_COST_MULTIPLIER * 10);
  return Math.ceil((Math.ceil(costMicroUsd) * CREDITS_PER_DOLLAR * multTenths) / 10_000_000);
}

/** Credits for a USD vendor cost at a multiplier: ceil(usd × 100 × m), ≥ 0. */
export function vendorUsdCredits(costUsd: number, multiplier: number = INTELLIGENCE_VENDOR_MULTIPLIER): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  // Round the cent product to 6 decimals first so float noise
  // (0.07 × 400 = 28.000000000000004) never rounds a whole number up.
  const cents = Math.round(costUsd * CREDITS_PER_DOLLAR * multiplier * 1e6) / 1e6;
  return Math.ceil(cents);
}

/** The Usage-page category of an action ("other" for unknown/uncategorised). */
export function categoryOf(action: string): CreditCategory {
  const def = (CREDIT_COSTS as Record<string, CreditCostDef>)[action];
  return def?.category ?? "other";
}

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
