// Marketr — mock SEO data provider.
//
// Used automatically when no real provider credentials are configured
// (see ./index). Every idea it returns is flagged `mock: true` so the UI
// can label the data honestly. It exists so the full keyword-research flow
// works end-to-end without paid API credentials — never ship it as real data.

import type {
  CompetitorKeyword,
  CompetitorKeywordsParams,
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

  async competitorKeywords({
    domain,
    limit = 25,
  }: CompetitorKeywordsParams): Promise<CompetitorKeyword[]> {
    // Deterministic pseudo-random from the domain, so the same domain
    // always shows the same mock snapshot within a session.
    const clean =
      domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0] || "competitor";
    const base = clean.split(".")[0] || "competitor";

    let h = 13;
    for (const c of clean) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const rand = () => {
      h = (h * 1103515245 + 12345) >>> 0;
      return h / 2 ** 32;
    };

    const TOPICS = [
      `${base} services`,
      `${base} pricing`,
      `${base} reviews`,
      `${base} vs`,
      `${base} alternatives`,
      `${base} cost`,
      `${base} near me`,
      `${base} for business`,
      `${base} features`,
      `${base} support`,
      `${base} demo`,
      `${base} sign up`,
      `${base} guide`,
      `${base} tips`,
      `${base} 2026`,
      `best ${base}`,
      `${base} for beginners`,
      `${base} pros and cons`,
      `${base} faq`,
      `${base} contact`,
      `${base} careers`,
      `${base} blog`,
      `${base} login`,
      `${base} app`,
      `${base} integrations`,
    ];

    const slug = (phrase: string) =>
      phrase
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return TOPICS.slice(0, Math.max(1, Math.min(limit, TOPICS.length))).map(
      (phrase) => ({
        phrase,
        volume: Math.round(50 + rand() * 20_000),
        difficulty: Math.round(5 + rand() * 80),
        cpc: Math.round(rand() * 400) / 100,
        intent: inferIntent(phrase),
        position: Math.round(1 + rand() * 19),
        url: `https://${clean}/${slug(phrase)}`,
        mock: true,
      } satisfies CompetitorKeyword),
    );
  }
}
