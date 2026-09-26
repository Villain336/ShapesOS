// Marketr — Phase 10 M8: community engagement (Okara-style, draft-first).
//
// Public surface. M3 consumes getCommunityOutcomes(); the UI consumes the
// scan + queue APIs; tests consume the pure pieces.

export * from "./types";
export { tasteCheck } from "./taste";
export { rankOpportunities, dedupeThreads } from "./ranking";
export { buildExpertiseProfile, loadExpertiseProfile } from "./expertise";
export { searchHackerNews } from "./sources/hn";
export { searchReddit, REDDIT_READ_ONLY_SCOPES } from "./sources/reddit";
export { fetchRssFeed, fetchRssFeeds } from "./sources/rss";
export {
  generateDraftText,
  queueCommunityDraft,
  COMMUNITY_TASTE_REJECTED_EVENT,
} from "./drafts";
export {
  recordCommunityOutcome,
  getCommunityOutcomes,
  type StoredOutcome,
} from "./outcomes";
export { scanCommunity, type ScanDeps } from "./scanner";
