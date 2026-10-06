// ShapesOS — per-model token prices (Phase 7).
//
// USD per 1M tokens. Because $/1M tokens == micro-USD per token, a cost in
// micro-USD is simply Σ tokens × price — no float division.
//
// Sources, checked 2026-10-04 (Phase 17 columns re-checked 2026-10-06):
//   - Anthropic: the official Claude API docs (bundled claude-api skill,
//     shared/models.md + shared/prompt-caching.md). Cache writes are 1.25×
//     input for the 5-minute TTL and 2× input for the 1-hour TTL
//     (prompt-caching.md § Economics: "Cache writes cost 1.25× for 5-minute
//     TTL, 2× for 1-hour TTL"). Phase 17 (A1) uses the 1-hour TTL for chat,
//     so the 1-hour share of a call's writes (usage.cache_creation.
//     ephemeral_1h_input_tokens) is priced at the 2× rate.
//     NOTE claude-fable-5-1 cache reads are $0.25 (0.025× input) per the
//     docs — not the ~$1.00 in the Phase 7 plan, which predates 5.1.
//   - Anthropic Message Batches: 50% of standard prices on every token
//     class (typescript/claude-api/batches.md: "50% cost reduction on all
//     token usage"). A call whose usage.service_tier is "batch" is priced
//     at BATCH_MULTIPLIER (Phase 17 A4).
//   - OpenAI: the provider's own pricing page,
//     https://developers.openai.com/api/docs/pricing (checked 2026-10-05,
//     Phase 15.2 — it replaced the third-party figures of Phase 7):
//       gpt-5.5       Standard $5.00 in / $0.50 cached / $30.00 out
//       gpt-5.4-nano  Standard $0.20 in / $0.02 cached / $1.25 out
//       gpt-5-nano    Standard $0.05 in / $0.005 cached / $0.40 out
//       gpt-5-nano    Flex     $0.025 in / $0.0025 cached / $0.20 out
//     ("gpt-5-nano:flex" is the router's alias for the Flex tier.) OpenAI
//     bills no cache-write premium and the adapter never reports cache-write
//     tokens for it.
//
// A price nobody has confirmed is `null` (unknown) — never guessed for the
// ESTIMATE (estimateCostMicroUsd returns null). Billing never charges 0 for
// an unknown price: billableCostMicroUsd() falls back to the most expensive
// known rate for that token class (Phase 15.2).

import type { ChatUsage } from "./types";

export interface ModelPrice {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  /** 5-minute-TTL cache write (1.25× input on Anthropic). */
  cacheWrite: number | null;
  /** Phase 17: 1-hour-TTL cache write (2× input on Anthropic; OpenAI has no write premium). */
  cacheWrite1h: number | null;
  source: "anthropic-docs" | "openai-docs" | "third-party";
}

/** Cache write (5-minute TTL) = 1.25 × input. */
const w = (input: number) => Math.round(input * 1.25 * 1000) / 1000;
/** Cache write (1-hour TTL) = 2 × input. */
const w1h = (input: number) => Math.round(input * 2 * 1000) / 1000;

const anthropic = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: w(input),
  cacheWrite1h: w1h(input),
  source: "anthropic-docs",
});
const openai = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: null,
  cacheWrite1h: null,
  source: "openai-docs",
});

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "claude-fable-5-1": anthropic(10, 50, 0.25),
  "claude-opus-5-5": anthropic(4, 20, 0.2),
  "claude-sonnet-5-5": anthropic(2, 10, 0.2),
  // Already allow-listed (Phase D); same docs. Opus 5 $5/$25, Sonnet 5 $2/$10, reads 0.1×.
  "claude-opus-5": anthropic(5, 25, 0.5),
  "claude-sonnet-5": anthropic(2, 10, 0.2),
  "claude-haiku-4-5": anthropic(1, 5, 0.1),
  "gpt-5.5": openai(5, 30, 0.5),
  "gpt-5.4-nano": openai(0.2, 1.25, 0.02),
  "gpt-5-nano": openai(0.05, 0.4, 0.005),
  "gpt-5-nano:flex": openai(0.025, 0.2, 0.0025),
});

export const PRICES_CHECKED_ON = "2026-10-06";

/** Phase 17 (A4): Message Batches are 50% of standard prices on every token class. */
export const BATCH_MULTIPLIER = 0.5;

export function priceFor(model: string): ModelPrice | null {
  return MODEL_PRICES[model] ?? null;
}

export interface CostOptions {
  /** The provider-reported service tier; "batch" halves the price. */
  serviceTier?: string | null;
}

function tierMultiplier(opts?: CostOptions): number {
  return opts?.serviceTier === "batch" ? BATCH_MULTIPLIER : 1;
}

type TokenClass = "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h";
const TOKEN_CLASSES: readonly TokenClass[] = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];

/** Tokens per price class. The 1-hour share of the writes is split out of cacheWriteTokens. */
function tokensByClass(usage: ChatUsage): Record<TokenClass, number> {
  const oneHour = Math.max(0, Math.min(usage.cacheWrite1hTokens ?? 0, usage.cacheWriteTokens));
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens - oneHour,
    cacheWrite1h: oneHour,
  };
}

/**
 * Estimated cost of one call in micro-USD (1 USD = 1,000,000), rounded.
 * Null when the model has no price entry, or when a token class that was
 * actually used has an unknown price.
 */
export function estimateCostMicroUsd(model: string, usage: ChatUsage, opts?: CostOptions): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const tokens = tokensByClass(usage);
  let total = 0;
  for (const c of TOKEN_CLASSES) {
    const n = tokens[c];
    if (!n) continue;
    const price = p[c];
    if (price === null) return null;
    total += n * price;
  }
  return Math.round(total * tierMultiplier(opts));
}

/**
 * Phase 15.2: the rate billing uses when a price is unknown — the most
 * expensive known rate for each token class across MODEL_PRICES (so never
 * less than the dearest model charges for it). Derived, so a new price
 * entry moves it automatically.
 */
export function fallbackPrice(): Record<TokenClass, number> {
  const out: Record<TokenClass, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  for (const p of Object.values(MODEL_PRICES)) {
    for (const c of TOKEN_CLASSES) {
      const v = p[c];
      if (v !== null && v > out[c]) out[c] = v;
    }
  }
  // A class nobody prices (OpenAI has no cache-write premium) falls back to
  // the input rate — a token is never free.
  for (const c of TOKEN_CLASSES) if (out[c] === 0) out[c] = out.input;
  return out;
}

/**
 * Phase 15.2: the cost BILLING uses for one call, in micro-USD (rounded up).
 * Known prices → the same figure as estimateCostMicroUsd; an unknown model,
 * or a used token class with an unknown price, is charged at fallbackPrice()
 * for that class — never 0. `priced` says whether the real price was known.
 */
export function billableCostMicroUsd(model: string, usage: ChatUsage, opts?: CostOptions): { costMicroUsd: number; priced: boolean } {
  const p = priceFor(model);
  const fb = fallbackPrice();
  const tokens = tokensByClass(usage);
  let total = 0;
  let priced = p !== null;
  for (const c of TOKEN_CLASSES) {
    const n = tokens[c];
    if (!n) continue;
    const rate = p?.[c] ?? null;
    if (rate === null) priced = false;
    total += n * (rate ?? fb[c]);
  }
  total *= tierMultiplier(opts);
  return { costMicroUsd: Math.ceil(Math.round(total * 1e6) / 1e6), priced };
}

/** "$0.0123" style label for a micro-USD amount (4 decimals under $1). */
export function formatMicroUsd(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd === 0) return "$0.00";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
