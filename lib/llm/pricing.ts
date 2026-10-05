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
//   - OpenAI (gpt-5.5, gpt-5-nano): THIRD-PARTY price trackers, not the
//     provider's own page. Re-check against https://openai.com/api/pricing
//     before relying on them for billing. OpenAI bills no cache-write premium
//     and the adapter never reports cache-write tokens for it.
//
// A price nobody has confirmed is `null` (unknown) — never guessed. An
// estimate that needs an unknown price returns null; so does an unknown model.

import type { ChatUsage } from "./types";

export interface ModelPrice {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  source: "anthropic-docs" | "third-party";
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
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: null, source: "third-party" },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: null, cacheWrite: null, source: "third-party" },
});

export const PRICES_CHECKED_ON = "2026-10-04";

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

/** "$0.0123" style label for a micro-USD amount (4 decimals under $1). */
export function formatMicroUsd(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd === 0) return "$0.00";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
