// Marketr — Phase 10 M2: test fixtures (official-source-shaped, no network).
//
// The docs-edit fixture MUST classify as docs_change (the flagship failure
// mode); the August 2026 Spam Update window MUST classify as rollout.

import type { RawSourceItem } from "../types";

/** Real-shape Search Central docs changelog entry (Sept 24, 2026). */
export const DOCS_EDIT_FIXTURE: RawSourceItem = {
  externalId: "2026-09-24-Added-creator-property-and-updated-interactionStatistic-in-VideoObject-structured-data",
  source: "search_central",
  title: "Added creator property and updated interactionStatistic in VideoObject structured data",
  summary:
    "What: Added the creator property (noting support for author) and updated interactionStatistic " +
    "to document supported interaction types in the VideoObject structured data documentation. " +
    "Why: To document support for the creator and author properties, and clarify supported interaction types.",
  startedAt: new Date("2026-09-24T00:00:00Z"),
  endedAt: null,
  url: "https://developers.google.com/search/updates#september-2026",
};

/** Real-shape Google Search Status Dashboard incident: August 2026 spam update. */
export const AUG_2026_SPAM_UPDATE_FIXTURE: RawSourceItem = {
  externalId: "LEubPCm2octf2uMqCFKE",
  source: "status_dashboard",
  title: "August 2026 spam update",
  summary:
    "Service: Ranking. Released the August 2026 spam update, which applies globally and to all languages. " +
    "The rollout may take a few days to complete. The rollout was complete as of August 21, 2026.",
  startedAt: new Date("2026-08-18T16:27:00Z"),
  endedAt: new Date("2026-08-21T08:49:00Z"),
  url: "https://status.search.google.com/incidents/LEubPCm2octf2uMqCFKE",
};

/** Dashboard ranking incident WITHOUT update naming (ongoing issue). */
export const RANKING_INCIDENT_FIXTURE: RawSourceItem = {
  externalId: "42XCLGtpuCZkzqe4dc6S",
  source: "status_dashboard",
  title: "Incident affecting Ranking",
  summary:
    "Service: Ranking. There's an ongoing issue with ranking in Google Search that's affecting a large " +
    "number of search results. We've identified the root cause.",
  startedAt: new Date("2026-09-20T03:21:00Z"),
  endedAt: null,
  url: "https://status.search.google.com/incidents/42XCLGtpuCZkzqe4dc6S",
};

/**
 * The adversarial fixture: docs language that NAME-DROPS an update family
 * ("updated the spam-updates documentation") — must stay docs_change.
 */
export const DOCS_MENTIONS_UPDATE_FAMILY_FIXTURE: RawSourceItem = {
  externalId: "2026-09-18-spam-updates-doc-refresh",
  source: "search_central",
  title: "Refreshed the spam updates documentation with new examples",
  summary:
    "What: Updated the spam updates documentation to add new examples of policy-violating behavior. " +
    "Why: To help site owners better understand what the spam policies cover.",
  startedAt: new Date("2026-09-18T00:00:00Z"),
  endedAt: null,
  url: "https://developers.google.com/search/updates#september-2026",
};

/** Bing blog item with unconfirmed-volatility language. */
export const BING_VOLATILITY_FIXTURE: RawSourceItem = {
  externalId: "7f6e0ecf-f638-43ff-a954-7160f3eea3e6",
  source: "bing_blog",
  title: "September search volatility: what the data shows",
  summary:
    "We've seen unconfirmed ranking volatility across several verticals this week. " +
    "This post reviews the flux signals from public trackers and what webmasters can check.",
  startedAt: new Date("2026-09-15T00:00:00Z"),
  endedAt: null,
  url: "https://blogs.bing.com/webmaster/2026/9/september-search-volatility",
};

/** Bing blog item announcing a confirmed Bing ranking change. */
export const BING_ROLLOUT_FIXTURE: RawSourceItem = {
  externalId: "a1b2c3d4-rollout",
  source: "bing_blog",
  title: "Bing completes September core ranking update rollout",
  summary:
    "The rollout of the September core ranking update is now complete. This algorithm update " +
    "refines how we assess content quality across all markets.",
  startedAt: new Date("2026-09-10T00:00:00Z"),
  endedAt: new Date("2026-09-17T00:00:00Z"),
  url: "https://blogs.bing.com/webmaster/2026/9/september-core-ranking-update",
};

/** Bing blog item that is pure documentation. */
export const BING_DOCS_FIXTURE: RawSourceItem = {
  externalId: "d4c3b2a1-docs",
  source: "bing_blog",
  title: "New guide: IndexNow for large publishers",
  summary:
    "We've published new documentation covering IndexNow integration for large publishers, " +
    "including updated API reference and migration examples.",
  startedAt: new Date("2026-09-12T00:00:00Z"),
  endedAt: null,
  url: "https://blogs.bing.com/webmaster/2026/9/indexnow-large-publishers",
};
