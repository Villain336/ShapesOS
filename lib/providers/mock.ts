// Marketr — mock SEO data provider.
//
// Used automatically when no real provider credentials are configured
// (see ./index). Every idea it returns is flagged `mock: true` so the UI
// can label the data honestly. It exists so the full keyword-research flow
// works end-to-end without paid API credentials — never ship it as real data.

import type {
  KeywordIdea,
  KeywordIdeasParams,
  SeoDataProvider,
} from "./types";
import { inferIntent } from "../keywords/intent";

const MODIFIERS = [
  "best",
  "guide",
  "how to choose",
  "pricing",
  "vs",
  "for beginners",
  "2026",
  "near me",
  "reviews",
  "tips",
  "cheap",
  "top 10",
  "alternatives",
  "cost",
  "examples",
];

export class MockSeoProvider implements SeoDataProvider {
  readonly name = "mock";
  readonly isLive = false;

  isConfigured(): boolean {
    return true;
  }

  async keywordIdeas({
    seed,
    limit = 25,
  }: KeywordIdeasParams): Promise<KeywordIdea[]> {
    // Deterministic pseudo-random from the seed, so the same seed
    // always shows the same mock ideas within a session.
    let h = 7;
    const s = seed.trim().toLowerCase() || "keyword";
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const rand = () => {
      h = (h * 1103515245 + 12345) >>> 0;
      return h / 2 ** 32;
    };

    return MODIFIERS.slice(0, Math.max(1, Math.min(limit, MODIFIERS.length))).map(
      (m) => {
        const phrase = `${m} ${s}`;
        return {
          phrase,
          volume: Math.round(50 + rand() * 20_000),
          difficulty: Math.round(5 + rand() * 80),
          cpc: Math.round(rand() * 400) / 100,
          intent: inferIntent(phrase),
          mock: true,
        } satisfies KeywordIdea;
      },
    );
  }
}
