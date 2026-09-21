// Marketr milestone 16 — fixture tests for local SEO (geo-grids, sentiment,
// cost controls, DataForSEO parsers, mock determinism, alert triggers).
//
// Run: npx tsx scripts/verify-m16-local.ts
// Pure functions only: no database, no network, no spend.

import {
  clampGridSize,
  generateGridCells,
  normalizeBusinessName,
  matchClientPosition,
  summarizeGridRun,
  diffGridRuns,
} from "@/lib/local/grid";
import {
  heuristicSentiment,
  classifySentiment,
  extractThemes,
  reviewSeverity,
} from "@/lib/local/sentiment";
import {
  LOCAL_PRICING,
  MAX_GRID_CELLS_PER_RUN,
  DEFAULT_LOCAL_SPEND_CAP_USD,
  estimateGridRunCost,
  estimateCompetitorRefreshCost,
  estimateReviewsIngestCost,
  checkLocalBudget,
} from "@/lib/seo/local-cost";
import {
  parseMapsSerpItems,
  parseBusinessListings,
  parseBusinessReviews,
} from "@/lib/providers/dataforseo";
import { getSeoProvider } from "@/lib/providers";
import { triggerDef } from "@/lib/alerts/triggers";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL: ${name}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected));
}

// ---------------------------------------------------------------- grid geometry
check("clamp(2)=2", clampGridSize(2) === 2);
check("clamp(5)=5", clampGridSize(5) === 5);
check("clamp(9)=9", clampGridSize(9) === 9);
check("clamp(1)->2", clampGridSize(1) === 2);
check("clamp(12)->9", clampGridSize(12) === 9);
check("clamp(NaN)->5", clampGridSize(NaN) === 5);
check("clamp(2.9)->2 (floor)", clampGridSize(2.9) === 2);

const g25 = generateGridCells(35.5, -80.0, 5, 5);
check("5×5 → 25 cells", g25.length === 25);
const g81 = generateGridCells(35.5, -80.0, 5, 9);
check("9×9 → 81 cells", g81.length === 81);
const g4 = generateGridCells(35.5, -80.0, 5, 2);
check("2×2 → 4 cells", g4.length === 4);
// Center cell of a 5×5 grid sits at the center point.
const center = g25.find((c) => c.row === 2 && c.col === 2);
check("5×5 center cell ≈ center point", center !== undefined && Math.abs(center.lat - 35.5) < 1e-9 && Math.abs(center.lng - -80.0) < 1e-9);
// Edge cells are offset by ±radius miles in latitude.
const north = g25.find((c) => c.row === 0 && c.col === 2);
check("5×5 north edge ≈ radius miles north", north !== undefined && Math.abs(35.5 - north.lat - 5 / 69.045) < 1e-4);
// Corners of 2×2 are spread around center.
check(
  "2×2 corners symmetric",
  g4.some((c) => c.lat > 35.5 && c.lng > -80.0) && g4.some((c) => c.lat < 35.5 && c.lng < -80.0),
);

// ------------------------------------------------------- business-name matching
check("normalize strips apostrophe/punctuation, lowercases", normalizeBusinessName("Joe's Plumbing & Co.") === "joes plumbing co");
eq(
  "match exact → position 1",
  matchClientPosition(
    [{ businessName: "Acme Plumbing Co" }, { businessName: "Other Shop" }],
    "Acme Plumbing Co",
  ),
  1,
);
eq(
  "match normalized containment → position 2",
  matchClientPosition(
    [{ businessName: "Random Biz" }, { businessName: "Acme Plumbing" }],
    "Acme Plumbing Co",
  ),
  2,
);
eq(
  "match token overlap → position 1",
  matchClientPosition([{ businessName: "Acme Plumbing Experts LLC" }], "Acme Plumbing Co"),
  1,
);
eq(
  "no match → null",
  matchClientPosition([{ businessName: "Totally Different" }, { businessName: "Unrelated Co" }], "Acme Plumbing Co"),
  null,
);
eq("empty client name → null", matchClientPosition([{ businessName: "Acme Plumbing" }], ""), null);

// ------------------------------------------------------------ grid summaries
const cells = [
  { row: 0, col: 0, lat: 35, lng: -80, position: 1, topBusiness: "Acme" },
  { row: 0, col: 1, lat: 35, lng: -80, position: 3, topBusiness: "Acme" },
  { row: 1, col: 0, lat: 35, lng: -80, position: null, topBusiness: "Rival" },
  { row: 1, col: 1, lat: 35, lng: -80, position: 2, topBusiness: "Acme" },
];
const summary = summarizeGridRun(cells);
check("coverage = 75% (3 of 4 cells)", summary.coveragePct === 75);
check("avg position = 2.0", summary.avgPosition === 2.0);
check("summary.cells = 4", summary.cells === 4);
const delta = diffGridRuns(
  { cells: 25, coveragePct: 60, avgPosition: 4.0 },
  { cells: 25, coveragePct: 75, avgPosition: 3.2 },
);
check("delta coverage +15", delta.coverageDeltaPct === 15);
check("delta position +0.8 (positive = improved)", delta.avgPositionDelta === 0.8);
const deltaNoPrev = diffGridRuns({ cells: 0, coveragePct: 0, avgPosition: null }, summary);
check("delta vs null-avg handles gracefully", deltaNoPrev.avgPositionDelta === null);

// ------------------------------------------------------------------- cost
check("MAX_GRID_CELLS_PER_RUN = 81", MAX_GRID_CELLS_PER_RUN === 81);
check("default cap = $25", DEFAULT_LOCAL_SPEND_CAP_USD === 25);
check("25-cell grid = $0.05", estimateGridRunCost(25) === 25 * LOCAL_PRICING.mapsSerpRequestUsd);
check("81-cell grid capped correctly", estimateGridRunCost(81) === 81 * LOCAL_PRICING.mapsSerpRequestUsd);
check("200 cells clamped to 81-cell cost", estimateGridRunCost(200) === estimateGridRunCost(81));
check("competitor refresh 3 = 3×listing price", estimateCompetitorRefreshCost(3) === 3 * LOCAL_PRICING.businessListingsRequestUsd);
check("reviews ingest = review task price", estimateReviewsIngestCost() === LOCAL_PRICING.reviewsTaskUsd);
const allow = checkLocalBudget(0.05, 0, 25);
check("budget allows 0.05 under $25 cap", allow.ok && allow.blockedReason === null);
const block = checkLocalBudget(0.05, 24.99, 25);
check("budget blocks when 24.99 + 0.05 > 25", !block.ok && block.blockedReason !== null);
const exact = checkLocalBudget(0.05, 24.95, 25);
check("budget allows exact fill to cap (25.00)", exact.ok);

// ---------------------------------------------------------------- sentiment
check("heuristic: 1★ nasty → neg", heuristicSentiment("terrible awful scam worst", 1) === "neg");
check("heuristic: 5★ praise → pos", heuristicSentiment("great friendly excellent", 5) === "pos");
check("heuristic: 3★ bland → neu", heuristicSentiment("it was fine, nothing special", 3) === "neu");
check("heuristic: rating-only 1★ → neg", heuristicSentiment(null, 1) === "neg");
check("heuristic: rating-only 5★ → pos", heuristicSentiment("", 5) === "pos");
check("heuristic: no text, no rating → neu", heuristicSentiment(null, null) === "neu");
check("severity 1★ → critical", reviewSeverity(1) === "critical");
check("severity 2★ → warn", reviewSeverity(2) === "warn");
check("severity 3★ → info", reviewSeverity(3) === "info");
check("severity 5★ → info", reviewSeverity(5) === "info");
check("severity null → info", reviewSeverity(null) === "info");
const themes = extractThemes([
  "The price was too high and parking was hard.",
  "Price was great, but parking was a nightmare.",
  "Friendly staff, loved the service.",
]);
check(
  "themes: parking count 2, price count 2",
  themes.some((t) => t.theme === "parking" && t.count === 2) &&
    themes.some((t) => t.theme === "price" && t.count === 2),
);
const classified = await classifySentiment("This place is awful, never again", 1);
check("classifySentiment never throws, heuristic fallback", classified.sentiment === "neg" && classified.via === "heuristic");

// ------------------------------------------------------ DataForSEO parsers
const mapsParsed = parseMapsSerpItems([
  { type: "maps_search", title: "Acme Plumbing", rating: "4.7", reviews_count: "231", address: "1 Main St", place_id: "ChIJ1", url: "https://acme.example", domain: "acme.example" },
  { type: "maps_search", title: "", rating: "4.0", reviews_count: "10" },
  { type: "organic", title: "Not a map listing" },
]);
check("maps parser keeps 1 valid item", mapsParsed.length === 1);
check("maps parser name", mapsParsed[0].businessName === "Acme Plumbing");
check("maps parser rating parsed", mapsParsed[0].rating === 4.7);
check("maps parser reviews_count", mapsParsed[0].reviewCount === 231);
check("maps parser position 1-based", mapsParsed[0].position === 1);

const listingsParsed = parseBusinessListings([
  { title: "Rival Co", rating: "4.2", reviews_count: "88", categories: ["Plumber", "Drain Service"], place_id: "p2", address: "2 Main", domain: "rival.example" },
  { title: "Solo Biz", category: "Electrician" },
  { title: "" },
]);
check("listings parser keeps 2", listingsParsed.length === 2);
eq("listings categories array kept", listingsParsed[0].categories, ["Plumber", "Drain Service"]);
eq("listings category string wrapped", listingsParsed[1].categories, ["Electrician"]);

const reviewsParsed = parseBusinessReviews([
  { review_id: "r1", profile_name: "Jane", rating: "5", review_text: "Loved it", timestamp: "2026-09-01T10:00:00Z" },
  { review_id: "r2", profile_name: "Bob", rating: "9", review_text: "meh" },
  { review_id: "r3" },
]);
check("reviews parser skips empty review", reviewsParsed.length === 2);
check("reviews parser rating kept", reviewsParsed[0].rating === 5);
check("reviews parser rating clamped to 5", reviewsParsed[1].rating === 5);
check("reviews parser author", reviewsParsed[0].author === "Jane");

// -------------------------------------------------------- mock determinism
const mock = getSeoProvider();
const m1 = await mock.mapsSerp({ keyword: "plumber", lat: 35.994, lng: -78.8986 });
const m2 = await mock.mapsSerp({ keyword: "plumber", lat: 35.994, lng: -78.8986 });
eq("mock mapsSerp deterministic", m1.items, m2.items);
check("mock mapsSerp rows marked mock", m1.items.every((i) => i.mock === true));
const rl1 = await mock.businessListings({ keyword: "Rival Co", lat: 35.994, lng: -78.8986 });
const rl2 = await mock.businessListings({ keyword: "Rival Co", lat: 35.994, lng: -78.8986 });
eq("mock businessListings deterministic", rl1, rl2);
const rv1 = await mock.businessReviews({ keyword: "Acme Plumbing", lat: 35.994, lng: -78.8986 });
const rv2 = await mock.businessReviews({ keyword: "Acme Plumbing", lat: 35.994, lng: -78.8986 });
eq("mock businessReviews deterministic", rv1.items, rv2.items);
check("mock reviews marked mock", rv1.items.every((i) => i.mock === true));

// --------------------------------------------------------------- triggers
for (const key of ["negative_review", "local_competitor_moved", "geo_grid_change"]) {
  const t = triggerDef(key);
  check(`trigger ${key} exists and is live`, t !== undefined && t.live === true);
}
check("negative_review conditions include severities", triggerDef("negative_review")?.conditionKeys.includes("severities") === true);
check("geo_grid_change conditions include thresholdPoints", triggerDef("geo_grid_change")?.conditionKeys.includes("thresholdPoints") === true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:", failures.join(", "));
  process.exit(1);
}
