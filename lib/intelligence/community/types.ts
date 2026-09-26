// Marketr — Phase 10 M8: community engagement (Okara-style, draft-first).
//
// Shared types for lib/intelligence/community.
//
// HARD INVARIANTS (enforced in tests, see __tests__/no-autopost.test.ts):
//   1. DRAFT-FIRST, ALWAYS. The module drafts replies; a human edits and
//      posts NATIVELY. Marketr never holds credentials to post on the user's
//      behalf and never autoposts. There is no code path in this module that
//      publishes to any platform — the only sink is the Phase 9 approval
//      inbox (mission_approvals, action "community_reply_draft").
//   2. NO PLATFORM SCRAPING. Reddit is reached only via the OFFICIAL API
//      with the user's own OAuth credentials (sources/reddit.ts). HN via the
//      free Algolia HN Search API. Niche forums via RSS feeds the user
//      configures. SPEC-PHASE10 §2: scraping Reddit/Maps is a hard 🚫 line —
//      Reddit v. Anthropic (Sept 2026) gave platform ToS contract-law teeth.
//   3. Taste gate: drafts that fail tasteCheck() never reach the inbox.

/** Where an opportunity thread lives. */
export type CommunitySourceId = "hacker_news" | "reddit" | "rss";

/** Why a thread is an opportunity. */
export type OpportunitySignal =
  | "competitor_mention"
  | "expertise_match"
  | "launch_moment";

/** A raw thread/comment pulled from a source adapter. */
export interface RawThread {
  source: CommunitySourceId;
  /** Source-native id (HN objectID, Reddit fullname, RSS guid/link). */
  externalId: string;
  title: string;
  /** Canonical public URL of the thread — the human posts natively here. */
  url: string;
  author?: string;
  /** Comment body or story text (may be empty for link posts). */
  text: string;
  points?: number;
  commentCount?: number;
  createdAt: Date;
  /** RSS only: which configured feed produced this. */
  feedName?: string;
}

/** A thread ranked against the workspace's expertise profile. */
export interface ScoredOpportunity extends RawThread {
  score: number;
  signals: OpportunitySignal[];
  matchedKeywords: string[];
  /** Human-readable one-liner shown in the queue UI. */
  relevanceReason: string;
}

/** What the workspace knows about — built from Phase 1 keyword storage. */
export interface ExpertiseProfile {
  /** Tracked keyword phrases (Keyword.tracked = true, Phase 1 storage). */
  trackedKeywords: string[];
  /** Competitor domains from the competitors table. */
  competitorDomains: string[];
  /** The workspace's own project domains (excluded from "competitor" hits). */
  projectDomains: string[];
}

/** The user's OWN Reddit OAuth app credentials. Marketr never proxies
 *  Reddit at platform scale — every call carries the user's credentials.
 *  Null/absent = unconfigured → the adapter degrades gracefully (skipped). */
export interface RedditConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The Reddit username Marketr drafts AS (honest identity, one account). */
  username: string;
}

/** A user-configured RSS feed (niche forums, Discourse/NodeBB RSS, etc.). */
export interface RssFeedConfig {
  name: string;
  url: string;
}

export interface CommunityScanInput {
  workspaceId: string;
  /** Who/what queued any resulting drafts (audit trail). */
  createdBy: string;
  reddit?: RedditConfig | null;
  rssFeeds?: RssFeedConfig[];
  /** Keyword phrases to search (defaults to tracked keywords). */
  queries?: string[];
  maxOpportunities?: number;
  /** How many top opportunities get drafted (default 5). 0 = discover only. */
  maxDrafts?: number;
  /** dryRun: discover + rank only. No LLM calls, no inbox writes. */
  dryRun?: boolean;
}

export interface TasteCheckResult {
  ok: boolean;
  failures: string[];
}

export interface QueuedDraft {
  opportunity: ScoredOpportunity;
  draft: string;
  approvalId: string;
  tasteCheck: TasteCheckResult;
}

export interface TasteRejected {
  opportunity: ScoredOpportunity;
  draft: string;
  failures: string[];
}

export interface CommunityScanReport {
  workspaceId: string;
  dryRun: boolean;
  scannedAt: string;
  sources: { source: CommunitySourceId; status: "ok" | "skipped" | "error"; detail: string }[];
  opportunities: ScoredOpportunity[];
  /** Drafts that passed taste and landed in the approval inbox. */
  queued: QueuedDraft[];
  /** Drafts that failed taste — logged, never reached the inbox. */
  tasteRejected: TasteRejected[];
}

/** A posted outcome the human records after posting natively. */
export interface CommunityOutcomeInput {
  approvalId: string;
  actor: string;
  postedAt?: string;
  upvotes?: number | null;
  replies?: number | null;
  /** Attributed visits, when the human knows them. */
  traffic?: number | null;
  note?: string;
}

/** Closed-loop outcome row — consumed by M3's branded-mention tracking. */
export interface CommunityOutcome {
  approvalId: string;
  source: CommunitySourceId;
  threadTitle: string;
  threadUrl: string;
  draftExcerpt: string;
  approvalStatus: string;
  postedAt: string | null;
  upvotes: number | null;
  replies: number | null;
  traffic: number | null;
  note: string | null;
}

/** The mission_approvals.action value for M8 drafts. Tier is always 2. */
export const COMMUNITY_DRAFT_ACTION = "community_reply_draft";
export const COMMUNITY_DRAFT_TIER = 2;

/** mission_approval_events.action for a human-recorded posted outcome. */
export const COMMUNITY_POSTED_EVENT = "community.posted";

/** mission_approval_events.action for a taste-check rejection log entry. */
export const COMMUNITY_TASTE_REJECTED_EVENT = "community.taste_rejected";
