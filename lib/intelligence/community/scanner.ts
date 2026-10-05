// Marketr — Phase 10 M8: community scan orchestration.
//
// One scan = discover (HN Algolia + Reddit official API + configured RSS)
// → dedupe → rank against the workspace expertise profile → draft the top
// N via the LLM → taste gate → queue in the Phase 9 approval inbox.
//
// Deps are injectable so tests run with zero network and zero database:
// fetchImpl, generate (LLM), approvalStore, loadProfile.

import { searchHackerNews } from "./sources/hn";
import { searchReddit } from "./sources/reddit";
import { fetchRssFeeds } from "./sources/rss";
import { loadExpertiseProfile } from "./expertise";
import { dedupeThreads, rankOpportunities } from "./ranking";
import { generateDraftText, queueCommunityDraft, type DraftDeps } from "./drafts";
import {
  COMMUNITY_DRAFT_ACTION,
  type CommunityScanInput,
  type CommunityScanReport,
  type CommunitySourceId,
  type ExpertiseProfile,
  type RawThread,
  type TasteRejected,
} from "./types";

export interface ScanDeps extends DraftDeps {
  fetchImpl?: typeof fetch;
  /** Override the expertise profile load (tests). */
  loadProfile?: (workspaceId: string) => Promise<ExpertiseProfile>;
  clock?: () => Date;
}

interface SourceStatus {
  source: CommunitySourceId;
  status: "ok" | "skipped" | "error";
  detail: string;
}

const MAX_QUERIES = 6;

function buildQueries(input: CommunityScanInput, profile: ExpertiseProfile): string[] {
  if (input.queries && input.queries.length > 0) {
    return input.queries.slice(0, MAX_QUERIES);
  }
  const kws = profile.trackedKeywords.slice(0, 4);
  const comps = profile.competitorDomains.slice(0, 2);
  const queries = [...kws, ...comps];
  return queries.length > 0 ? queries.slice(0, MAX_QUERIES) : ["marketing"];
}

async function discover(
  input: CommunityScanInput,
  queries: string[],
  deps: ScanDeps,
): Promise<{ threads: RawThread[]; sources: SourceStatus[] }> {
  const fetchImpl = deps.fetchImpl;
  const sources: SourceStatus[] = [];
  const threads: RawThread[] = [];

  // Hacker News — free Algolia search API, no key.
  try {
    for (const q of queries) {
      threads.push(...(await searchHackerNews(q, { fetchImpl, hitsPerPage: 15 })));
    }
    sources.push({ source: "hacker_news", status: "ok", detail: `${queries.length} querie(s)` });
  } catch (e) {
    sources.push({ source: "hacker_news", status: "error", detail: (e as Error).message });
  }

  // Reddit — official API with the user's own OAuth; graceful when unconfigured.
  try {
    for (const q of queries) {
      const r = await searchReddit(input.reddit ?? null, q, { fetchImpl, limit: 10 });
      threads.push(...r.opportunities);
      if (q === queries[0]) {
        sources.push({
          source: "reddit",
          status: r.configured ? "ok" : "skipped",
          detail: r.detail,
        });
      }
    }
  } catch (e) {
    sources.push({ source: "reddit", status: "error", detail: (e as Error).message });
  }

  // RSS — user-configured niche-forum feeds.
  const feeds = input.rssFeeds ?? [];
  if (feeds.length === 0) {
    sources.push({ source: "rss", status: "skipped", detail: "no feeds configured" });
  } else {
    try {
      threads.push(...(await fetchRssFeeds(feeds, { fetchImpl })));
      sources.push({ source: "rss", status: "ok", detail: `${feeds.length} feed(s)` });
    } catch (e) {
      sources.push({ source: "rss", status: "error", detail: (e as Error).message });
    }
  }

  return { threads: dedupeThreads(threads), sources };
}

/**
 * Run a full community scan. dryRun discovers + ranks only (no LLM calls,
 * no inbox writes) — cheap enough to run from the UI preview button.
 */
export async function scanCommunity(
  input: CommunityScanInput,
  deps: ScanDeps = {},
): Promise<CommunityScanReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const profile = deps.loadProfile
    ? await deps.loadProfile(input.workspaceId)
    : await loadExpertiseProfile(input.workspaceId);

  const queries = buildQueries(input, profile);
  const { threads, sources } = await discover(input, queries, deps);
  const ranked = rankOpportunities(threads, profile, now);
  const maxOpportunities = Math.max(1, input.maxOpportunities ?? 15);
  const opportunities = ranked.slice(0, maxOpportunities);

  const report: CommunityScanReport = {
    workspaceId: input.workspaceId,
    dryRun: input.dryRun ?? false,
    scannedAt: now.toISOString(),
    sources,
    opportunities,
    queued: [],
    tasteRejected: [],
  };
  if (report.dryRun) return report;

  const maxDrafts = Math.max(0, input.maxDrafts ?? 5);
  const tasteRejected: TasteRejected[] = [];
  for (const opportunity of opportunities.slice(0, maxDrafts)) {
    const { draft, taste } = await generateDraftText(opportunity, profile, { workspaceId: input.workspaceId, ...deps });
    if (!taste.ok) {
      tasteRejected.push({ opportunity, draft, failures: taste.failures });
      if (deps.onTasteReject) deps.onTasteReject({ opportunity, draft, failures: taste.failures });
      continue;
    }
    // Draft text is pre-generated; queueCommunityDraft re-checks taste
    // (defense in depth) and writes the ONLY sink: the approval inbox.
    const queued = await queueCommunityDraft(
      {
        workspaceId: input.workspaceId,
        createdBy: input.createdBy,
        opportunity,
        draft,
        profile,
      },
      {
        ...deps,
        onTasteReject: (r) => {
          tasteRejected.push(r);
          if (deps.onTasteReject) deps.onTasteReject(r);
        },
      },
    );
    if (queued.queued && queued.approvalId) {
      report.queued.push({
        opportunity,
        draft: queued.draft ?? draft,
        approvalId: queued.approvalId,
        tasteCheck: queued.taste,
      });
    }
  }
  report.tasteRejected = tasteRejected;
  return report;
}

/** Re-exported so the no-autopost test can assert the module's only sink. */
export { COMMUNITY_DRAFT_ACTION };
