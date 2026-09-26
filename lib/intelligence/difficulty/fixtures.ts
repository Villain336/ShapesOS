// Marketr — Phase 10 M5: synthetic SERP fixtures for CI.
//
// These fixtures let the model be exercised with ZERO live API keys —
// M7 runs the fixture eval in CI. They are hand-built to encode known
// orderings:
//
//   easy_longtail  <  medium_competitive  <  hard_head_term
//   aio_heavy      has high crowding  →  estimate pushed up (AIO crushes
//                  organic CTR, so the model honestly scores it harder than
//                  its raw authority alone would suggest)
//   unknown_authority  has no signals  →  wide uncertainty band
//
// Domain authority numbers are ILLUSTRATIVE (synthetic), not measurements.
// Only the RELATIVE ordering matters: fortress domains (DA 80–95) vs.
// niche blogs (DA 15–40).

import type { RawAuthoritySignals, SerpInput } from "./model";

export interface SyntheticFixture {
  keyword: string;
  locale: string;
  serp: SerpInput;
  authority: RawAuthoritySignals[];
  /** M6-style volume band. */
  volumeBand: string;
  /** Expected relative rank: lower number = easier. */
  expectedRank: number;
}

function r(position: number, domain: string, title: string) {
  return { position, url: `https://${domain}/article-${position}`, domain, title };
}

function auth(domain: string, mozDA: number, oprInteger: number, ccPrPos: number): RawAuthoritySignals {
  return { domain, mozDA, oprInteger, ccPrPos, ccGraphSize: 90_000_000 };
}

const NICHE: RawAuthoritySignals[] = [
  auth("smallspaceorganizing.com", 28, 3, 4_200_000),
  auth("quietapartmentliving.blog", 19, 2, 9_800_000),
  auth("budgethomeoffice.co", 34, 4, 2_100_000),
  auth("ergonomicsdaily.net", 22, 2, 7_400_000),
  auth("desksetupguide.com", 31, 3, 3_300_000),
  auth("tinyworkspaces.io", 17, 2, 12_000_000),
  auth("comfortdeskblog.com", 25, 3, 5_600_000),
  auth("posturefixhq.com", 29, 3, 4_900_000),
  auth("homeofficeninja.net", 21, 2, 8_100_000),
  auth("chairlabreviews.com", 36, 4, 1_800_000),
];

const MIXED: RawAuthoritySignals[] = [
  auth("projectmanager.com", 62, 6, 180_000),
  auth("techrepublic.com", 88, 8, 12_000),
  auth("asana.com", 79, 7, 48_000),
  auth("monday.com", 76, 7, 65_000),
  auth("teamwork.com", 71, 7, 95_000),
  auth("capterra.com", 84, 8, 22_000),
  auth("g2.com", 86, 8, 18_000),
  auth("smartsheet.com", 74, 7, 72_000),
  auth("wrike.com", 73, 7, 88_000),
  auth("clickup.com", 77, 7, 55_000),
];

const FORTRESS: RawAuthoritySignals[] = [
  auth("geico.com", 78, 7, 42_000),
  auth("progressive.com", 82, 8, 28_000),
  auth("statefarm.com", 75, 7, 51_000),
  auth("allstate.com", 76, 7, 47_000),
  auth("nerdwallet.com", 91, 9, 6_500),
  auth("investopedia.com", 91, 9, 5_800),
  auth("thebalancemoney.com", 87, 8, 14_000),
  auth("bankrate.com", 89, 9, 9_200),
  auth("usnews.com", 93, 9, 3_100),
  auth("forbes.com", 95, 9, 1_900),
];

const AIO_MIXED: RawAuthoritySignals[] = [
  auth("experian.com", 84, 8, 19_000),
  auth("equifax.com", 81, 8, 26_000),
  auth("myfico.com", 77, 7, 44_000),
  auth("creditkarma.com", 88, 8, 11_000),
  auth("nerdwallet.com", 91, 9, 6_500),
  auth("wallethub.com", 83, 8, 21_000),
  auth("consumerfinance.gov", 90, 9, 7_800),
  auth("discover.com", 82, 8, 24_000),
  auth("capitalone.com", 85, 8, 16_000),
  auth("chase.com", 87, 8, 13_000),
];

const UNKNOWN: RawAuthoritySignals[] = [
  // Deliberately EMPTY — these domains exist in no authority source.
  // The model must still produce an estimate, but with a wide band.
];

/** Domains present in the SERP but in NO authority source. */
const UNKNOWN_DOMAINS = [
  "quantum-ferret-reviews.xyz",
  "nichegadgetlab.blog",
  "obscure-teardown-reports.net",
  "ferretfan-forum.example",
  "gadgetwhisperer.blog",
  "deepnicheguides.io",
  "unranked-review-desk.com",
  "longtail-lab.notes",
];

function domainsOf(list: RawAuthoritySignals[]): string[] {
  return list.map((a) => a.domain);
}

function serpFrom(domains: string[], opts: { aiOverview: boolean; features: string[] }): SerpInput {
  return {
    results: domains.map((d, i) => r(i + 1, d, `Result ${i + 1} for ${d}`)),
    aiOverviewPresent: opts.aiOverview,
    serpFeatures: opts.features,
  };
}

export const SYNTHETIC_FIXTURES: SyntheticFixture[] = [
  {
    keyword: "best ergonomic office chair for short people under $200",
    locale: "en-US",
    serp: serpFrom(domainsOf(NICHE), { aiOverview: false, features: ["people_also_ask"] }),
    authority: NICHE,
    volumeBand: "100–1K",
    expectedRank: 1, // easiest
  },
  {
    keyword: "project management software for small teams",
    locale: "en-US",
    serp: serpFrom(domainsOf(MIXED), {
      aiOverview: false,
      features: ["people_also_ask", "top_stories"],
    }),
    authority: MIXED,
    volumeBand: "1K–10K",
    expectedRank: 2,
  },
  {
    keyword: "insurance",
    locale: "en-US",
    serp: serpFrom(domainsOf(FORTRESS), {
      aiOverview: false,
      features: ["people_also_ask", "top_stories", "knowledge_panel"],
    }),
    authority: FORTRESS,
    volumeBand: "1M+",
    expectedRank: 3, // hardest
  },
  {
    keyword: "what is a good credit score",
    locale: "en-US",
    serp: serpFrom(domainsOf(AIO_MIXED), {
      aiOverview: true,
      features: ["ai_overview", "featured_snippet", "people_also_ask"],
    }),
    authority: AIO_MIXED,
    volumeBand: "100K–1M",
    expectedRank: 2, // medium authority but AIO-crowded → estimate pushed up
  },
  {
    keyword: "quantum ferret habitat setup guide",
    locale: "en-US",
    serp: serpFrom(UNKNOWN_DOMAINS, { aiOverview: false, features: [] }),
    authority: UNKNOWN,
    volumeBand: "0–10",
    expectedRank: 0, // trivially easy — but only 2 domains known
  },
];

/** Convenience: keyword → fixture. */
export const FIXTURE_BY_KEYWORD = new Map(
  SYNTHETIC_FIXTURES.map((f) => [f.keyword, f]),
);
