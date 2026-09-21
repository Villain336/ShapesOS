// Marketr — mock SEO data provider.
//
// Used automatically when no real provider credentials are configured
// (see ./index). Every idea it returns is flagged `mock: true` so the UI
// can label the data honestly. It exists so the full keyword-research flow
// works end-to-end without paid API credentials — never ship it as real data.

import type {
  BacklinkItem,
  BacklinkSummaryData,
  BacklinkSummaryParams,
  BacklinksParams,
  BacklinksResult,
  BusinessListing,
  BusinessListingsParams,
  BusinessReviewItem,
  BusinessReviewsParams,
  BusinessReviewsResult,
  CompetitorKeyword,
  CompetitorKeywordsParams,
  KeywordIdea,
  KeywordIdeasParams,
  MapsSerpItem,
  MapsSerpParams,
  MapsSerpResult,
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

/**
 * Fixed anchor for deterministic mock review timestamps (illustrative dates —
 * mock only, not real review dates). Must live at module scope.
 */
const MOCK_REVIEWS_ANCHOR_MS = Date.parse("2026-09-01T00:00:00Z");

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

    return {
      results,
      peopleAlsoAsk,
      // Deterministic AI Overview presence for the mock: ~40% of keywords show one.
      // Always labeled mock: true above — never confuse this with real detection.
      aiOverviewPresent: rand() < 0.4,
      mock: true,
    };
  }

  async backlinks({ target, limit = 100 }: BacklinksParams): Promise<BacklinksResult> {
    // Deterministic mock backlink profile: same target always yields the same
    // rows. Labeled mock: true — never confuse with real DataForSEO data.
    const clean = target.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || "example.com";
    let h = 41;
    for (const c of clean) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const rand = () => {
      h = (h * 1103515245 + 12345) >>> 0;
      return h / 2 ** 32;
    };

    const REFERRERS = [
      "industryblog.com", "newsoutlet.io", "partner-site.org", "reviewhub.net",
      "communityforum.dev", "resourcepage.co", "directorylist.com", "blognetwork.io",
      "pressrelease.site", "localguide.org", "tutorialhub.dev", "comparisonpost.com",
    ];
    const ANCHORS = [
      "learn more", "this guide", "best tools", "read the full report",
      clean, "click here", "helpful resource", "2026 review",
    ];

    const count = Math.max(1, Math.min(limit, 40));
    const items: BacklinkItem[] = [];
    for (let i = 0; i < count; i++) {
      const domain = REFERRERS[Math.floor(rand() * REFERRERS.length)];
      items.push({
        sourceDomain: domain,
        sourceUrl: `https://${domain}/posts/${Math.floor(rand() * 9000 + 1000)}`,
        targetUrl: `https://${clean}/${["", "blog/", "pricing/", "features/"][Math.floor(rand() * 4)]}${Math.floor(rand() * 50) === 0 ? "guide" : ""}`.replace(/\/$/, "") || `https://${clean}`,
        anchorText: ANCHORS[Math.floor(rand() * ANCHORS.length)],
        dofollow: rand() < 0.7,
        firstSeen: new Date(Date.now() - Math.floor(rand() * 400) * 86400000).toISOString(),
        lastSeen: new Date(Date.now() - Math.floor(rand() * 7) * 86400000).toISOString(),
        sourceRank: Math.round(rand() * 900),
        spamScore: Math.round(rand() * 40),
        mock: true,
      });
    }
    return { items, totalCount: items.length, rowsReturned: items.length, mock: true };
  }

  async backlinksSummary({ target }: BacklinkSummaryParams): Promise<BacklinkSummaryData> {
    // Deterministic mock summary, consistent-ish with backlinks().
    const clean = target.trim().toLowerCase() || "example.com";
    let h = 43;
    for (const c of clean) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const rand = () => {
      h = (h * 1103515245 + 12345) >>> 0;
      return h / 2 ** 32;
    };
    const total = Math.round(80 + rand() * 1200);
    return {
      total,
      referringDomains: Math.round(total / (3 + rand() * 6)),
      dofollowCount: Math.round(total * (0.55 + rand() * 0.25)),
      mock: true,
    };
  }

  // Milestone 16: deterministic mock local SEO data. The grid cell's lat/lng
  // feed the hash so neighboring cells see slightly different maps results —
  // enough to make heatmaps look plausible. Review dates are anchored to a
  // fixed constant (illustrative) so the output is deterministic.
  // Labeled mock: true throughout.

  async mapsSerp({ keyword, lat, lng }: MapsSerpParams): Promise<MapsSerpResult> {
    const s = (keyword.trim().toLowerCase() || "service").slice(0, 40);
    let h = 97;
    const key = `${s}|${lat.toFixed(4)},${lng.toFixed(4)}`;
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const rand = () => {
      h = (h * 1103515245 + 12345) >>> 0;
      return h / 2 ** 32;
    };
    const NAMES = [
      "Acme Services", "Prime Pros", "TopNotch Co", "Reliable & Sons",
      "Citywide Experts", "Blue Ribbon", "Golden Standard", "Neighborly Fix",
    ];
    const count = 5 + Math.floor(rand() * 4); // 5–8 listings per cell
    const items: MapsSerpItem[] = [];
    for (let i = 0; i < count; i++) {
      const name = NAMES[Math.floor(rand() * NAMES.length)];
      items.push({
        businessName: name,
        rating: Math.round((3.6 + rand() * 1.3) * 10) / 10,
        reviewCount: Math.round(12 + rand() * 480),
        address: `${Math.floor(rand() * 9000 + 100)} Main St`,
        placeId: `mock-place-${Math.floor(rand() * 1e9)}`,
        url: `https://${name.toLowerCase().replace(/[^a-z]+/g, "")}.example.com`,
        domain: `${name.toLowerCase().replace(/[^a-z]+/g, "")}.example.com`,
        position: i + 1,
        mock: true,
      });
    }
    return { items, mock: true };
  }

  async businessListings({
    keyword,
    limit = 10,
  }: BusinessListingsParams): Promise<BusinessListing[]> {
    const s = (keyword.trim().toLowerCase() || "business").slice(0, 40);
    let h = 101;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const rand = () => {
      h = (h * 1103515245 + 12345) >>> 0;
      return h / 2 ** 32;
    };
    const CATS = ["Service", "Contractor", "Consultant", "Repair service"];
    const out: BusinessListing[] = [];
    const count = Math.max(1, Math.min(limit, 10));
    for (let i = 0; i < count; i++) {
      const name = `${s.split(" ")[0] ?? "local"} ${["Pro", "Plus", "Co", "Group", "Works"][Math.floor(rand() * 5)]}`;
      out.push({
        businessName: name,
        placeId: `mock-place-${Math.floor(rand() * 1e9)}`,
        rating: Math.round((3.5 + rand() * 1.4) * 10) / 10,
        reviewCount: Math.round(8 + rand() * 600),
        categories: [CATS[Math.floor(rand() * CATS.length)]],
        address: `${Math.floor(rand() * 9000 + 100)} Oak Ave`,
        domain: `${name.toLowerCase().replace(/[^a-z]+/g, "")}.example.com`,
        mock: true,
      });
    }
    return out;
  }

  async businessReviews({
    keyword,
    depth = 20,
  }: BusinessReviewsParams): Promise<BusinessReviewsResult> {
    const s = (keyword.trim().toLowerCase() || "business").slice(0, 40);
    let h = 103;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const rand = () => {
      h = (h * 1103515245 + 12345) >>> 0;
      return h / 2 ** 32;
    };
    const AUTHORS = ["Jordan", "Casey", "Riley", "Avery", "Morgan", "Taylor", "Quinn", "Sam"];
    const TEXTS: Record<number, string[]> = {
      5: ["Fantastic service, highly recommend!", "Best in town — quick and professional.", "Exceeded expectations in every way."],
      4: ["Good experience overall, minor scheduling hiccup.", "Solid work, fair price."],
      3: ["Average. Got the job done eventually.", "Okay service, nothing special."],
      2: ["Disappointing — had to call twice to fix issues.", "Slow response and sloppy finish."],
      1: ["Terrible experience, would not recommend.", "Worst service I've ever had. Avoid!"],
    };
    const items: BusinessReviewItem[] = [];
    const count = Math.max(1, Math.min(depth, 20));
    for (let i = 0; i < count; i++) {
      // Weight toward positive, like a real profile.
      const r = rand();
      const rating = r < 0.55 ? 5 : r < 0.75 ? 4 : r < 0.85 ? 3 : r < 0.93 ? 2 : 1;
      const texts = TEXTS[rating];
      items.push({
        externalId: `mock-rev-${Math.floor(rand() * 1e9)}`,
        author: AUTHORS[Math.floor(rand() * AUTHORS.length)],
        rating,
        text: texts[Math.floor(rand() * texts.length)],
        publishedAt: new Date(MOCK_REVIEWS_ANCHOR_MS - Math.floor(rand() * 90) * 86400000).toISOString(),
        mock: true,
      });
    }
    return { items, mock: true };
  }
}
