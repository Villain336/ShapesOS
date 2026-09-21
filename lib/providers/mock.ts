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
  SerpResult,
  SerpResultsParams,
  SerpSnapshot,
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

  async serpResults({
    keyword,
    depth = 10,
  }: SerpResultsParams): Promise<SerpSnapshot> {
    // Deterministic mock SERP: same keyword always shows the same snapshot.
    const s = keyword.trim().toLowerCase() || "keyword";
    const titleCase = s.replace(/\b\w/g, (c) => c.toUpperCase());

    const DOMAINS = [
      "completeguide.io",
      "howpedia.org",
      "expertblog.net",
      "guidely.io",
      "reviewly.co",
      "praxis.blog",
      "knowhow.dev",
      "insightpost.com",
      "masterly.io",
      "contenthub.com",
    ];

    const TITLES = [
      `${titleCase}: The Complete 2026 Guide`,
      `How to Choose ${titleCase} (Expert Tips)`,
      `Best ${titleCase} — Top 10 Compared`,
      `What Is ${titleCase}? Beginner's Guide`,
      `${titleCase} vs. Alternatives: Which Is Right for You?`,
      `${titleCase} Pricing, Reviews & FAQ`,
      `10 ${titleCase} Mistakes to Avoid`,
      `${titleCase} Near Me: How to Find the Best`,
      `The Ultimate ${titleCase} Checklist`,
      `${titleCase} Pros and Cons, Explained`,
    ];

    const DESCRIPTIONS = [
      `Everything you need to know about ${s}: costs, options, and expert advice in one place.`,
      `Compare the best ${s} options for 2026. Real reviews, transparent pricing, no fluff.`,
      `Our experts break down ${s} step by step so you can decide with confidence.`,
    ];

    let h = 29;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const rand = () => {
      h = (h * 1103515245 + 12345) >>> 0;
      return h / 2 ** 32;
    };

    const slug = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    const count = Math.max(1, Math.min(depth, TITLES.length));
    const results: SerpResult[] = TITLES.slice(0, count).map((title, i) => ({
      domain: DOMAINS[i % DOMAINS.length],
      url: `https://${DOMAINS[i % DOMAINS.length]}/${slug(s)}-${i + 1}`,
      title,
      description: DESCRIPTIONS[Math.floor(rand() * DESCRIPTIONS.length)],
      position: i + 1,
      mock: true,
    }));

    const peopleAlsoAsk = [
      `What is ${s}?`,
      `How much does ${s} cost?`,
      `Is ${s} worth it?`,
      `What is the best ${s}?`,
      `How do I choose ${s}?`,
      `Where can I find ${s} near me?`,
    ];

    return { results, peopleAlsoAsk, mock: true };
  }
}
