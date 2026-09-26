// Marketr — Phase 10 M9: the BINDING ingest allowlist.
//
// This module is the code-level enforcement of the clean-sourcing tiers
// (SPEC-PHASE10.md §M9). Ingestion MUST call assertIngestAllowed() before
// writing a single chunk; the test suite asserts that the registry contains
// ONLY Tier 1-shippable + Tier 2 sources and that forbidden sources throw.

import type { CorpusLicenseKind, CorpusSourceRecord } from "./types";

/** Licenses that may ship in the MAIN (AGPL-repo) corpus asset. */
const MAIN_ASSET_LICENSES: ReadonlySet<CorpusLicenseKind> = new Set([
  "CC-BY-4.0",
  "CC-BY-3.0",
  "CC0-1.0",
  "MIT",
  "public-domain",
]);

/** BY-SA material is shippable ONLY into the separately-licensed asset
 *  (data/corpus/by-sa/ with its own LICENSE note). Never in the main asset. */
const SEGREGATED_LICENSES: ReadonlySet<CorpusLicenseKind> = new Set([
  "CC-BY-SA-4.0",
]);

export type IngestDecision =
  | { allowed: true; segregatedAsset: false }
  | { allowed: true; segregatedAsset: true }
  | { allowed: false; reason: string };

/**
 * The single gate every ingest path must pass. Returns the asset decision;
 * throws on forbidden material. Tier 3 / learn-only / NC / ripped material
 * all fail here — before any byte is written.
 */
export function assertIngestAllowed(def: {
  id: string;
  title: string;
  tier: 1 | 2 | "learn-only" | 3 | string;
  license: CorpusLicenseKind | "learn-only" | "unknown" | string;
}): IngestDecision {
  const { id, title, tier, license } = def;

  if (tier === 3 || tier === "learn-only") {
    throw new Error(
      `[corpus] REFUSED ingest of "${title}" (${id}): tier ${String(tier)} is never ingested ` +
        `verbatim (Tier 3 = private overlay only; learn-only academies = original synthesis only).`,
    );
  }
  if (tier !== 1 && tier !== 2) {
    throw new Error(`[corpus] REFUSED ingest of "${title}" (${id}): unknown tier ${String(tier)}.`);
  }
  // Tier 1 shippable = CC-BY-4.0 ONLY (Google Search Central). Any other
  // Tier 1 license (e.g. all-rights-reserved academies) is learn-only.
  if (tier === 1 && license !== "CC-BY-4.0") {
    throw new Error(
      `[corpus] REFUSED ingest of "${title}" (${id}): Tier 1 source with license ${String(license)} ` +
        `— only CC-BY-4.0 platform materials (Google Search Central) may be ingested verbatim.`,
    );
  }
  if (SEGREGATED_LICENSES.has(license as CorpusLicenseKind)) {
    return { allowed: true, segregatedAsset: true };
  }
  if (MAIN_ASSET_LICENSES.has(license as CorpusLicenseKind)) {
    return { allowed: true, segregatedAsset: false };
  }
  throw new Error(
    `[corpus] REFUSED ingest of "${title}" (${id}): license ${String(license)} is not a ` +
      `shippable open license (NC/ND/all-rights-reserved are never ingested).`,
  );
}

/**
 * Full 24-source registry (M9-CORPUS-SOURCES.md #1–24). Sources with a fetch
 * URL are ingested by scripts/ingest-corpus.mts; sources whose fetch is
 * blocked or whose license is uncertain are recorded PENDING with a reason
 * — never ingested. Learn-only sources (#2–8, #21–24) are registry entries
 * for the manifest ONLY (status "active"/"pending" per their Tier 1S
 * playbook); assertIngestAllowed() throws if verbatim ingest is ever
 * attempted for them.
 */
export interface SeedSourceDef {
  id: string;
  title: string;
  author: string;
  tier: 1 | 2 | "learn-only";
  license: CorpusLicenseKind | "learn-only";
  licenseUrl: string;
  /** One or more clean URLs to fetch; empty = manual/pending. */
  fetchUrls: string[];
  /** "html" (strip tags) | "text" (plain) | "mediawiki" (Wikipedia API). */
  format: "html" | "text" | "mediawiki";
  /** "browser" sends a browser-like UA — required by pressbooks mirrors
   *  that 403 bot UAs (verified 2026-09-26). Public content, no bypass. */
  ua?: "browser";
  pendingReason?: string;
  /**
   * Tier 1S synthesis playbook (learn-only sources ONLY). The file lives in
   * data/corpus/synthesis/ and contains Marketr-ORIGINAL words distilled
   * from the learn-only source(s) — never verbatim text. Ingested by
   * ingestSynthesisPlaybook(), never by the verbatim path (the gate
   * refuses learn-only material there).
   */
  playbook?: { file: string; synthesizedFrom: string[] };
}

export const SEED_SOURCES: readonly SeedSourceDef[] = [
  {
    id: "google-search-central",
    title: "Google Search Central documentation",
    author: "Google",
    tier: 1,
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    fetchUrls: [
      "https://developers.google.com/search/docs/fundamentals/seo-starter-guide",
      "https://developers.google.com/search/docs/fundamentals/how-search-works",
      "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
      "https://developers.google.com/search/docs/essentials/spam-policies",
    ],
    format: "html",
  },
  {
    id: "grayson-foundations-digital-marketing",
    title: "Foundations in Digital Marketing",
    author: "Rochelle Grayson (BCcampus)",
    tier: 2,
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    // Canonical opentextbc.ca copy (the uregina.ca mirror 403'd 2026-09-26).
    // Chapter URLs extracted from the book's table of contents.
    fetchUrls: [
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/introduction-to-digital-marketing/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/fundamentals-of-storytelling/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/target-market-and-audiences/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/customer-personas/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/customer-journey/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/content-marketing/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/search-engine-optimization/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/paid-advertising-search-engine-marketing/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/social-media-marketing/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/email-marketing/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/mobile-marketing/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/website-and-landing-page-optimization/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/conversion-rate-optimization/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/a-b-testing/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/a-lead-generation-framework/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/digital-marketing-analytics-and-calculations/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/attribution/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/visual-storytelling/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/visual-language-and-sketchnoting/",
      "https://opentextbc.ca/foundationsdigitalmarketing/chapter/future-digital-marketing-trends/",
    ],
    format: "html",
  },
  {
    id: "scientific-advertising",
    title: "Scientific Advertising",
    author: "Claude Hopkins",
    tier: 2,
    license: "public-domain",
    licenseUrl: "https://archive.org/details/scientific-advertising-by-calude-hopkins",
    fetchUrls: [
      "https://archive.org/download/scientific-advertising-by-calude-hopkins/ScientificAdvertising%20by%20calude%20hopkins_djvu.txt",
    ],
    format: "text",
  },
  {
    id: "my-life-in-advertising",
    title: "My Life in Advertising",
    author: "Claude Hopkins",
    tier: 2,
    license: "public-domain",
    licenseUrl: "https://archive.org/details/mylifeinadvertis0000clau",
    fetchUrls: [
      "https://archive.org/download/mylifeinadvertis0000clau/mylifeinadvertis0000clau_djvu.txt",
    ],
    format: "text",
    pendingReason: undefined,
  },
  {
    id: "burnett-introducing-marketing",
    title: "Introducing Marketing",
    author: "John Burnett (Global Text Project)",
    tier: 2,
    license: "CC-BY-3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "No clean chapter-level URL located for the CC-BY 3.0 edition; ingest deferred until the source is verified (do not ingest from uncertain mirrors).",
  },
  {
    id: "nscc-intro-marketing",
    title: "Introduction to Marketing I (MKTG 1010)",
    author: "NSCC, adapted from Lumen Learning",
    tier: 2,
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    // CC BY 4.0 confirmed by the book's version-history page (adapted from
    // Lumen Learning's Principles of Marketing, CC BY 4.0). Pressbooks
    // mirrors 403 bot UAs — fetch with a browser UA (verified 2026-09-26).
    fetchUrls: [
      "https://pressbooks.atlanticoer-relatlantique.ca/nsccprinciplesofmarketing2e/chapter/reading-components-of-the-marketing-mix/",
      "https://pressbooks.atlanticoer-relatlantique.ca/nsccprinciplesofmarketing2e/chapter/outcome-marketing-mix/",
      "https://pressbooks.atlanticoer-relatlantique.ca/nsccprinciplesofmarketing2e/chapter/reading-components-of-the-marketing-strategy/",
      "https://pressbooks.atlanticoer-relatlantique.ca/nsccprinciplesofmarketing2e/chapter/putting-it-together-marketing-strategy/",
      "https://pressbooks.atlanticoer-relatlantique.ca/nsccprinciplesofmarketing2e/chapter/outcome-role-of-marketing-plan/",
    ],
    format: "html",
    ua: "browser",
  },
  {
    id: "scott-psychology-of-advertising",
    title: "The Psychology of Advertising",
    author: "Walter Dill Scott",
    tier: 2,
    license: "public-domain",
    licenseUrl: "https://archive.org/details/psychologyadver00scotgoog",
    fetchUrls: [
      "https://archive.org/download/psychologyadver00scotgoog/psychologyadver00scotgoog_djvu.txt",
    ],
    format: "text",
    pendingReason: undefined,
  },
  {
    id: "calkins-business-of-advertising",
    title: "The Business of Advertising",
    author: "Earnest Elmo Calkins",
    tier: 2,
    license: "public-domain",
    licenseUrl: "https://archive.org/details/businessofadvert00calk",
    // Original 1915 D. Appleton edition scan (Duke/UNC libraries, 2008) —
    // raw OCR of the PD text, not an annotated reprint (verified 2026-09-26).
    fetchUrls: [
      "https://archive.org/download/businessofadvert00calk/businessofadvert00calk_djvu.txt",
    ],
    format: "text",
  },
  {
    id: "sba-marketing-guides",
    title: "SBA Business Guide — Marketing & Sales",
    author: "U.S. Small Business Administration",
    tier: 2,
    license: "public-domain",
    licenseUrl: "https://www.usa.gov/government-works",
    fetchUrls: [
      "https://www.sba.gov/business-guide/plan-your-business/market-research-competitive-analysis",
      "https://www.sba.gov/business-guide/manage-your-business/marketing-sales",
    ],
    format: "html",
  },
  {
    id: "ftc-dot-com-disclosures",
    title: ".com Disclosures: How to Make Effective Disclosures in Digital Advertising",
    author: "U.S. Federal Trade Commission",
    tier: 2,
    license: "public-domain",
    licenseUrl: "https://www.usa.gov/government-works",
    // PENDING (2026-09-26): the HTML page yields only navigation chrome
    // (ingest produced 2 junk chunks — discarded, nothing ingested). The
    // substantive staff guidance is the linked PDF "bus41" (public domain),
    // deferred until a PDF→text ingest path exists.
    fetchUrls: [],
    format: "html",
    pendingReason:
      "HTML page returns only navigation chrome (2 junk chunks on ingest — discarded); " +
      "the substantive guidance is the linked FTC staff-guidance PDF (bus41, public domain). " +
      "Deferred until a PDF-to-text ingest path is built.",
  },
  {
    id: "wikipedia-marketing-clusters",
    title: "Wikipedia marketing clusters",
    author: "Wikimedia contributors",
    tier: 2,
    license: "CC-BY-SA-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    fetchUrls: [
      "Marketing",
      "Digital_marketing",
      "Search_engine_optimization",
      "Content_marketing",
      "Email_marketing",
      "Social_media_marketing",
      "Marketing_mix",
      "Advertising",
    ],
    format: "mediawiki",
  },
  {
    id: "marketingskills",
    title: "marketingskills (GitHub)",
    author: "coreyhaines31",
    tier: 2,
    license: "MIT",
    licenseUrl: "https://opensource.org/licenses/MIT",
    // 2026-09-26: repo lists as existing (MIT, branch main) but every
    // contents/raw/API endpoint returns 404 — contents unreachable.
    fetchUrls: [],
    format: "text",
    pendingReason:
      "GitHub repo coreyhaines31/marketskills resolves but all raw/contents/API endpoints return 404 as of 2026-09-26; ingest deferred until a clean URL is verified (never ingest from third-party mirrors).",
  },
  {
    id: "marketing-without-money",
    title: "marketing-without-money (GitHub)",
    author: "edljx",
    tier: 2,
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    fetchUrls: [
      "https://raw.githubusercontent.com/edljx/marketing-without-money/main/README.md",
    ],
    format: "text",
  },
  // Learn-only sources — manifest entries only. The verbatim ingest gate
  // REFUSES them; they feed the corpus ONLY via Tier 1S original-synthesis
  // playbooks (data/corpus/synthesis/*.md), authored in Marketr's own words
  // with factual attribution. ingestSynthesisPlaybook() enforces that a
  // playbook may only cite learn-only registry sources.
  {
    id: "meta-blueprint",
    title: "Meta Blueprint",
    author: "Meta",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason: undefined,
    playbook: { file: "paid-social-playbook.md", synthesizedFrom: ["Meta Blueprint"] },
  },
  {
    id: "google-skillshop",
    title: "Google Skillshop",
    author: "Google",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason: undefined,
    playbook: { file: "paid-search-playbook.md", synthesizedFrom: ["Google Skillshop"] },
  },
  {
    id: "bing-webmaster",
    title: "Bing Webmaster Guidelines",
    author: "Microsoft",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason: undefined,
    playbook: { file: "bing-grounding-playbook.md", synthesizedFrom: ["Bing Webmaster Guidelines"] },
  },
  {
    id: "tiktok-academy",
    title: "TikTok Academy",
    author: "TikTok",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason: undefined,
    playbook: { file: "short-form-video-ads-playbook.md", synthesizedFrom: ["TikTok Academy"] },
  },
  {
    id: "linkedin-marketing-labs",
    title: "LinkedIn Marketing Labs",
    author: "LinkedIn",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason: undefined,
    playbook: { file: "b2b-paid-playbook.md", synthesizedFrom: ["LinkedIn Marketing Labs"] },
  },
  {
    id: "hubspot-academy",
    title: "HubSpot Academy",
    author: "HubSpot",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Learn-only: HubSpot ToS §6.1 explicitly bans copying/derivative works. Feeds the corpus only via the original-synthesis playbook below.",
    playbook: { file: "inbound-marketing-playbook.md", synthesizedFrom: ["HubSpot Academy"] },
  },
  {
    id: "trailhead",
    title: "Salesforce Trailhead (marketing tracks)",
    author: "Salesforce",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Learn-only: Trailhead explicitly bans scraping for AI-model training. Feeds the corpus only via the original-synthesis playbook below.",
    playbook: { file: "email-engagement-playbook.md", synthesizedFrom: ["Salesforce Trailhead"] },
  },
  {
    id: "cxl-blog",
    title: "CXL blog",
    author: "CXL",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free practitioner publication: short attributed quotation under fair use only, NOT bulk ingestion. Original-synthesis playbook below.",
    playbook: { file: "experimentation-playbook.md", synthesizedFrom: ["CXL blog"] },
  },
  {
    id: "copyhackers-blog",
    title: "Copyhackers blog",
    author: "Copyhackers (Joanna Wiebe)",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free practitioner publication: short attributed quotation under fair use only, NOT bulk ingestion. Original-synthesis playbook below.",
    playbook: { file: "conversion-copy-playbook.md", synthesizedFrom: ["Copyhackers blog"] },
  },
  {
    id: "demand-curve-blog",
    title: "Demand Curve blog",
    author: "Demand Curve",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free practitioner publication: short attributed quotation under fair use only, NOT bulk ingestion. Original-synthesis playbook below.",
    playbook: { file: "startup-acquisition-playbook.md", synthesizedFrom: ["Demand Curve blog"] },
  },
  {
    id: "ahrefs-blog",
    title: "Ahrefs blog / Academy",
    author: "Ahrefs",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "High-signal free practitioner content, all-rights-reserved: synthesis only. Original-synthesis playbook below.",
    playbook: { file: "seo-tactics-playbook.md", synthesizedFrom: ["Ahrefs blog"] },
  },
  // ── Tier 1S wave 2 (2026-09-26): 19 new playbooks, 24 learn-only sources.
  // All Marketr-original synthesis; the verbatim gate REFUSES them.
  {
    id: "x-for-business",
    title: "X for Business / Flight School",
    author: "X",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free platform academy, all-rights-reserved: synthesis only. Original-synthesis playbook below.",
    playbook: { file: "x-business-playbook.md", synthesizedFrom: ["X for Business / Flight School"] },
  },
  {
    id: "pinterest-academy",
    title: "Pinterest Academy",
    author: "Pinterest",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free platform academy, all-rights-reserved: synthesis only. Original-synthesis playbook below.",
    playbook: { file: "pinterest-academy-playbook.md", synthesizedFrom: ["Pinterest Academy"] },
  },
  {
    id: "snapchat-ads",
    title: "Snapchat for Business",
    author: "Snap",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free platform business docs, all-rights-reserved: synthesis only. Original-synthesis playbook below.",
    playbook: { file: "snapchat-ads-playbook.md", synthesizedFrom: ["Snapchat for Business"] },
  },
  {
    id: "youtube-creator-academy",
    title: "YouTube Creator Academy",
    author: "YouTube",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free platform academy, all-rights-reserved: synthesis only. Original-synthesis playbook below.",
    playbook: { file: "youtube-creator-playbook.md", synthesizedFrom: ["YouTube Creator Academy"] },
  },
  {
    id: "amazon-ads-learning",
    title: "Amazon Ads Learning Console",
    author: "Amazon",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free platform academy, all-rights-reserved: synthesis only. Original-synthesis playbook below.",
    playbook: { file: "amazon-ads-playbook.md", synthesizedFrom: ["Amazon Ads Learning Console"] },
  },
  {
    id: "reddit-for-business",
    title: "Reddit for Business",
    author: "Reddit",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free platform business docs, all-rights-reserved: synthesis only. Original-synthesis playbook below.",
    playbook: { file: "reddit-ads-playbook.md", synthesizedFrom: ["Reddit for Business"] },
  },
  {
    id: "apple-hig",
    title: "Apple Human Interface Guidelines",
    author: "Apple",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free to read, all rights reserved: learn-and-synthesize only, never ingest. Original-synthesis playbook below.",
    playbook: { file: "apple-hig-playbook.md", synthesizedFrom: ["Apple Human Interface Guidelines"] },
  },
  {
    id: "material-3",
    title: "Material Design 3",
    author: "Google",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Guideline text all-rights-reserved (icons are Apache 2.0, code aside): synthesis only. Original-synthesis playbook below.",
    playbook: { file: "material-3-playbook.md", synthesizedFrom: ["Material Design 3"] },
  },
  {
    id: "microsoft-fluent",
    title: "Microsoft Fluent (Fluent 2)",
    author: "Microsoft",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Guidance text all-rights-reserved (Fluent UI code is MIT): synthesis only. Original-synthesis playbook below.",
    playbook: { file: "fluent-playbook.md", synthesizedFrom: ["Microsoft Fluent"] },
  },
  {
    id: "nng",
    title: "Nielsen Norman Group",
    author: "Nielsen Norman Group",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free articles, all-rights-reserved: synthesis only. Original-synthesis playbook below.",
    playbook: { file: "nng-heuristics-playbook.md", synthesizedFrom: ["Nielsen Norman Group"] },
  },
  {
    id: "laws-of-ux",
    title: "Laws of UX",
    author: "Jon Yablonski",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free site, author-retained rights [UNVERIFIED license]: synthesize ideas only. Original-synthesis playbook below.",
    playbook: { file: "laws-of-ux-playbook.md", synthesizedFrom: ["Laws of UX"] },
  },
  {
    id: "practical-typography",
    title: "Practical Typography",
    author: "Matthew Butterick",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free to read online, © all-rights-reserved ('no part may be reproduced'): PARAPHRASE ONLY, never ingest. Original-synthesis playbook below.",
    playbook: { file: "practical-typography-playbook.md", synthesizedFrom: ["Practical Typography"] },
  },
  {
    id: "baymard",
    title: "Baymard Institute (free articles)",
    author: "Baymard Institute",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free articles, all-rights-reserved: synthesis only; percentages are study-bound benchmarks, never constants. Original-synthesis playbook below.",
    playbook: { file: "baymard-checkout-playbook.md", synthesizedFrom: ["Baymard Institute"] },
  },
  {
    id: "atomic-design",
    title: "Atomic Design",
    author: "Brad Frost",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free book, no verifiable license [UNVERIFIED]: synthesize ideas only. Original-synthesis playbook below.",
    playbook: { file: "atomic-design-playbook.md", synthesizedFrom: ["Atomic Design (Brad Frost)"] },
  },
  {
    id: "style-guide-guide",
    title: "Style Guide Guide",
    author: "Brad Frost",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free site, author-retained rights: synthesize ideas only. Original-synthesis playbook below.",
    playbook: { file: "style-guide-ops-playbook.md", synthesizedFrom: ["Style Guide Guide (Brad Frost)"] },
  },
  {
    id: "refactoring-ui",
    title: "Refactoring UI (public writing)",
    author: "Adam Wathan & Steve Schoger",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "The book is paywalled (Tier 3, never ingested); this playbook synthesizes the authors' free public writing and talks only. Original-synthesis playbook below.",
    playbook: { file: "refactoring-ui-playbook.md", synthesizedFrom: ["Refactoring UI (public writing)"] },
  },
  {
    id: "emil-kowalski",
    title: "Emil Kowalski (design-engineering writing)",
    author: "Emil Kowalski",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free blog/newsletter, author-retained rights: synthesize ideas only. Original-synthesis playbook below.",
    playbook: { file: "motion-craft-playbook.md", synthesizedFrom: ["Emil Kowalski"] },
  },
  {
    id: "growth-design",
    title: "Growth.Design",
    author: "Growth.Design",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Free case-study teardowns, all-rights-reserved: synthesis only. Original-synthesis playbook below.",
    playbook: { file: "growth-design-teardowns-playbook.md", synthesizedFrom: ["Growth.Design"] },
  },
  // Enterprise design-systems survey: six registry entries, ONE shared
  // comparative-survey playbook file (ingested once — the ingest script
  // dedupes shared playbook files; the other five entries record as
  // covered-by-survey, never re-ingested).
  {
    id: "ibm-carbon",
    title: "IBM Carbon Design System",
    author: "IBM",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Guidance text all-rights-reserved: synthesis only, via the comparative survey playbook below.",
    playbook: { file: "enterprise-design-systems-playbook.md", synthesizedFrom: ["IBM Carbon", "Atlassian Design System", "Adobe Spectrum", "Shopify Polaris", "GitHub Primer", "Salesforce Lightning Design System"] },
  },
  {
    id: "atlassian-design",
    title: "Atlassian Design System",
    author: "Atlassian",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Guidance text all-rights-reserved: synthesis only, via the comparative survey playbook below.",
    playbook: { file: "enterprise-design-systems-playbook.md", synthesizedFrom: ["IBM Carbon", "Atlassian Design System", "Adobe Spectrum", "Shopify Polaris", "GitHub Primer", "Salesforce Lightning Design System"] },
  },
  {
    id: "adobe-spectrum",
    title: "Adobe Spectrum",
    author: "Adobe",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Guidance text all-rights-reserved: synthesis only, via the comparative survey playbook below.",
    playbook: { file: "enterprise-design-systems-playbook.md", synthesizedFrom: ["IBM Carbon", "Atlassian Design System", "Adobe Spectrum", "Shopify Polaris", "GitHub Primer", "Salesforce Lightning Design System"] },
  },
  {
    id: "shopify-polaris",
    title: "Shopify Polaris",
    author: "Shopify",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Guidance text all-rights-reserved: synthesis only, via the comparative survey playbook below.",
    playbook: { file: "enterprise-design-systems-playbook.md", synthesizedFrom: ["IBM Carbon", "Atlassian Design System", "Adobe Spectrum", "Shopify Polaris", "GitHub Primer", "Salesforce Lightning Design System"] },
  },
  {
    id: "github-primer",
    title: "GitHub Primer",
    author: "GitHub",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Guidance text all-rights-reserved: synthesis only, via the comparative survey playbook below.",
    playbook: { file: "enterprise-design-systems-playbook.md", synthesizedFrom: ["IBM Carbon", "Atlassian Design System", "Adobe Spectrum", "Shopify Polaris", "GitHub Primer", "Salesforce Lightning Design System"] },
  },
  {
    id: "salesforce-lightning",
    title: "Salesforce Lightning Design System",
    author: "Salesforce",
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    fetchUrls: [],
    format: "html",
    pendingReason:
      "Guidance text all-rights-reserved: synthesis only, via the comparative survey playbook below.",
    playbook: { file: "enterprise-design-systems-playbook.md", synthesizedFrom: ["IBM Carbon", "Atlassian Design System", "Adobe Spectrum", "Shopify Polaris", "GitHub Primer", "Salesforce Lightning Design System"] },
  },
];

/**
 * Tier 1S synthesis playbooks, in ingestion order. Each entry names the
 * Marketr-original playbook file and the learn-only registry source(s) it
 * was distilled from (learn-only registry ids only — enforced at ingest).
 * 30 entries: the 11 wave-1 playbooks plus the 19 wave-2 files (one entry
 * per file; the enterprise survey file is shared by six registry sources).
 */
export const SYNTHESIS_PLAYBOOKS: readonly SynthesisPlaybookRef[] = [
  { sourceId: "meta-blueprint", file: "paid-social-playbook.md", title: "Paid Social Campaign Playbook", synthesizedFrom: ["Meta Blueprint"] },
  { sourceId: "google-skillshop", file: "paid-search-playbook.md", title: "Paid Search Campaign Playbook", synthesizedFrom: ["Google Skillshop"] },
  { sourceId: "bing-webmaster", file: "bing-grounding-playbook.md", title: "Bing Webmaster & AI Grounding Playbook", synthesizedFrom: ["Bing Webmaster Guidelines"] },
  { sourceId: "tiktok-academy", file: "short-form-video-ads-playbook.md", title: "Short-Form Video Ads Playbook", synthesizedFrom: ["TikTok Academy"] },
  { sourceId: "linkedin-marketing-labs", file: "b2b-paid-playbook.md", title: "B2B Paid Advertising Playbook", synthesizedFrom: ["LinkedIn Marketing Labs"] },
  { sourceId: "hubspot-academy", file: "inbound-marketing-playbook.md", title: "Inbound Marketing Playbook", synthesizedFrom: ["HubSpot Academy"] },
  { sourceId: "trailhead", file: "email-engagement-playbook.md", title: "Email Engagement Playbook", synthesizedFrom: ["Salesforce Trailhead"] },
  { sourceId: "cxl-blog", file: "experimentation-playbook.md", title: "Experimentation & CRO Playbook", synthesizedFrom: ["CXL blog"] },
  { sourceId: "copyhackers-blog", file: "conversion-copy-playbook.md", title: "Conversion Copy Playbook", synthesizedFrom: ["Copyhackers blog"] },
  { sourceId: "demand-curve-blog", file: "startup-acquisition-playbook.md", title: "Startup Acquisition Playbook", synthesizedFrom: ["Demand Curve blog"] },
  { sourceId: "ahrefs-blog", file: "seo-tactics-playbook.md", title: "SEO Tactics Playbook", synthesizedFrom: ["Ahrefs blog"] },
  // Tier 1S wave 2 (2026-09-26): 19 new playbook files (one entry per file;
  // the enterprise survey file is shared by six registry sources).
  { sourceId: "x-for-business", file: "x-business-playbook.md", title: "X for Business Playbook", synthesizedFrom: ["X for Business / Flight School"] },
  { sourceId: "pinterest-academy", file: "pinterest-academy-playbook.md", title: "Pinterest Academy Playbook", synthesizedFrom: ["Pinterest Academy"] },
  { sourceId: "snapchat-ads", file: "snapchat-ads-playbook.md", title: "Snapchat Ads Playbook", synthesizedFrom: ["Snapchat for Business"] },
  { sourceId: "youtube-creator-academy", file: "youtube-creator-playbook.md", title: "YouTube Creator Playbook", synthesizedFrom: ["YouTube Creator Academy"] },
  { sourceId: "amazon-ads-learning", file: "amazon-ads-playbook.md", title: "Amazon Ads Playbook", synthesizedFrom: ["Amazon Ads Learning Console"] },
  { sourceId: "reddit-for-business", file: "reddit-ads-playbook.md", title: "Reddit Ads Playbook", synthesizedFrom: ["Reddit for Business"] },
  { sourceId: "apple-hig", file: "apple-hig-playbook.md", title: "Apple HIG Playbook", synthesizedFrom: ["Apple Human Interface Guidelines"] },
  { sourceId: "material-3", file: "material-3-playbook.md", title: "Material Design 3 Playbook", synthesizedFrom: ["Material Design 3"] },
  { sourceId: "microsoft-fluent", file: "fluent-playbook.md", title: "Fluent Design Playbook", synthesizedFrom: ["Microsoft Fluent"] },
  { sourceId: "nng", file: "nng-heuristics-playbook.md", title: "NN/g Heuristics Playbook", synthesizedFrom: ["Nielsen Norman Group"] },
  { sourceId: "laws-of-ux", file: "laws-of-ux-playbook.md", title: "Laws of UX Playbook", synthesizedFrom: ["Laws of UX"] },
  { sourceId: "practical-typography", file: "practical-typography-playbook.md", title: "Practical Typography Playbook", synthesizedFrom: ["Practical Typography"] },
  { sourceId: "baymard", file: "baymard-checkout-playbook.md", title: "Baymard Checkout Playbook", synthesizedFrom: ["Baymard Institute"] },
  { sourceId: "atomic-design", file: "atomic-design-playbook.md", title: "Atomic Design Playbook", synthesizedFrom: ["Atomic Design (Brad Frost)"] },
  { sourceId: "style-guide-guide", file: "style-guide-ops-playbook.md", title: "Style Guide Ops Playbook", synthesizedFrom: ["Style Guide Guide (Brad Frost)"] },
  { sourceId: "refactoring-ui", file: "refactoring-ui-playbook.md", title: "Refactoring UI Playbook", synthesizedFrom: ["Refactoring UI (public writing)"] },
  { sourceId: "emil-kowalski", file: "motion-craft-playbook.md", title: "Motion Craft Playbook", synthesizedFrom: ["Emil Kowalski"] },
  { sourceId: "growth-design", file: "growth-design-teardowns-playbook.md", title: "Growth Design Teardowns Playbook", synthesizedFrom: ["Growth.Design"] },
  { sourceId: "ibm-carbon", file: "enterprise-design-systems-playbook.md", title: "Enterprise Design Systems Survey Playbook", synthesizedFrom: ["IBM Carbon", "Atlassian Design System", "Adobe Spectrum", "Shopify Polaris", "GitHub Primer", "Salesforce Lightning Design System"] },
];

/** Registry lookup (for the ingest script + manifest writer). */
export function seedSourceById(id: string): SeedSourceDef | undefined {
  return SEED_SOURCES.find((s) => s.id === id);
}

/** The shape of one Tier 1S synthesis playbook registry entry. */
export interface SynthesisPlaybookRef {
  sourceId: string;
  file: string;
  title: string;
  synthesizedFrom: string[];
}

/** The registry must contain only allowlist-conformant definitions. */
export function registryConformance(): Array<{ id: string; ok: boolean; reason: string }> {
  return SEED_SOURCES.map((s) => {
    try {
      assertIngestAllowed(s);
      return { id: s.id, ok: true, reason: s.license === "CC-BY-SA-4.0" ? "segregated BY-SA asset" : "main asset" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const expected = s.tier === "learn-only";
      return { id: s.id, ok: expected, reason: expected ? `correctly refused: ${msg.slice(0, 80)}…` : `UNEXPECTED REFUSAL: ${msg}` };
    }
  });
}
