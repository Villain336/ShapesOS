// ShapesOS — per-model token prices (Phase 7).
//
// USD per 1M tokens. Because $/1M tokens == micro-USD per token, a cost in
// micro-USD is simply Σ tokens × price — no float division.
//
// Sources, checked 2026-10-04:
//   - Anthropic: the official Claude API docs (bundled claude-api skill,
//     shared/models.md + shared/prompt-caching.md). Cache writes are the
//     5-minute TTL rate, 1.25× input (the adapters only use the default TTL).
//     NOTE claude-fable-5-1 cache reads are $0.25 (0.025× input) per the
//     docs — not the ~$1.00 in the Phase 7 plan, which predates 5.1.
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
  cacheWrite: number | null;
  source: "anthropic-docs" | "openai-docs" | "third-party";
}

/** Cache write (5-minute TTL) = 1.25 × input. */
const w = (input: number) => Math.round(input * 1.25 * 1000) / 1000;

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: w(10), source: "anthropic-docs" },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: w(4), source: "anthropic-docs" },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: w(2), source: "anthropic-docs" },
  // Already allow-listed (Phase D); same docs. Opus 5 $5/$25, Sonnet 5 $2/$10, reads 0.1×.
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: w(5), source: "anthropic-docs" },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: w(2), source: "anthropic-docs" },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: w(1), source: "anthropic-docs" },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: null, source: "openai-docs" },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: null, source: "openai-docs" },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: null, source: "openai-docs" },
  "gpt-5-nano:flex": { input: 0.025, output: 0.2, cacheRead: 0.0025, cacheWrite: null, source: "openai-docs" },
});

export const PRICES_CHECKED_ON = "2026-10-05";

export function priceFor(model: string): ModelPrice | null {
  return MODEL_PRICES[model] ?? null;
}

/**
 * Estimated cost of one call in micro-USD (1 USD = 1,000,000), rounded.
 * Null when the model has no price entry, or when a token class that was
 * actually used has an unknown price.
 */
export function estimateCostMicroUsd(model: string, usage: ChatUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const parts: Array<[number, number | null]> = [
    [usage.inputTokens, p.input],
    [usage.outputTokens, p.output],
    [usage.cacheReadTokens, p.cacheRead],
    [usage.cacheWriteTokens, p.cacheWrite],
  ];
  let total = 0;
  for (const [tokens, price] of parts) {
    if (!tokens) continue;
    if (price === null) return null;
    total += tokens * price;
  }
  return Math.round(total);
}

type TokenClass = "input" | "output" | "cacheRead" | "cacheWrite";
const TOKEN_CLASSES: readonly TokenClass[] = ["input", "output", "cacheRead", "cacheWrite"];

/**
 * Phase 15.2: the rate billing uses when a price is unknown — the most
 * expensive known rate for each token class across MODEL_PRICES (so never
 * less than the dearest model charges for it). Derived, so a new price
 * entry moves it automatically.
 */
export function fallbackPrice(): Record<TokenClass, number> {
  const out: Record<TokenClass, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
export function billableCostMicroUsd(model: string, usage: ChatUsage): { costMicroUsd: number; priced: boolean } {
  const p = priceFor(model);
  const fb = fallbackPrice();
  const tokens: Record<TokenClass, number> = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
  };
  let total = 0;
  let priced = p !== null;
  for (const c of TOKEN_CLASSES) {
    const n = tokens[c];
    if (!n) continue;
    const rate = p?.[c] ?? null;
    if (rate === null) priced = false;
    total += n * (rate ?? fb[c]);
  }
  return { costMicroUsd: Math.ceil(Math.round(total * 1e6) / 1e6), priced };
}

/** "$0.0123" style label for a micro-USD amount (4 decimals under $1). */
export function formatMicroUsd(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd === 0) return "$0.00";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
